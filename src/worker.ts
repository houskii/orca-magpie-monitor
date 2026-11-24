import type { OrcaWorkerApi } from 'orca/worker'
import { emptySnapshot, type ConversationPreview, type FocusedConversation, type Session, type Snapshot } from './protocol'
import { cchostSource, quotaSelection, gatewayBaseURL, parseCards, SessionMeter } from './metrics'
import { readConversations } from './conversations'
import { sessionLabel, statusSessionText } from './session-label'
import { cachePercent, compactTokens, conversationAgentLabel, currentQuota, currentSession, liveRate, meanLabel, quotaLabel, quotaTone, quotaWindowName, quotaWindows, rate, resetTime, speedNote, statusSessions, speedTone, speedValue } from './presentation'
import { readFocus, watchFocus } from './focus'
import { createPopup, type MonitorPopup } from './popup'
import { attachUsage, readSessionUsage, usageKey, type SessionUsage } from './usage-source'
import { boundedJSON, MAX_SESSIONS, panelSnapshot } from './bounds'
import { readAntigravitySession } from './antigravity-source'
import { parseIgnoredQuotaModels } from './model-filter'

type MonitorOptions = { send?: typeof fetch; clock?: () => number; background?: boolean;
  conversations?: (sessions: string[]) => Promise<ConversationPreview[]>;
  focus?: () => Promise<FocusedConversation | null>;
  native?: typeof readAntigravitySession;
  popup?: MonitorPopup }
let stop: (() => void) | undefined
export function activateMonitor(orca: OrcaWorkerApi, options: MonitorOptions = {}): () => void {
  const send = options.send || fetch, clock = options.clock || Date.now
  let meter = new SessionMeter(), state = emptySnapshot(), quotaAt = -Infinity, stopped = false
  let pending: Promise<Snapshot> | null = null, quotaTask: Promise<void> | null = null
  let quotaRevision = 0, quotaCancel: AbortController | null = null, writingSettings = false
  let gatewayToken = ''
  let quotaIgnored = false
  let conversationTask: Promise<void> | null = null, conversationAt = -Infinity
  let focusTask: Promise<void> | null = null, focusAt = -Infinity
  let historyRow: Session | null = null
  let previews = new Map<string, ConversationPreview>()
  const popup = options.popup || createPopup(orca.log)
  const barCache = new Map<string, string>()
  const barErrors = new Map<string, string>()
  const usage = new Map<string,SessionUsage>()
  let usageTask:Promise<void>|null=null,usageAt=-Infinity
  let timer: ReturnType<typeof setTimeout> | undefined
  let focusTimer: ReturnType<typeof setTimeout> | undefined
  let focusWakeTimer: ReturnType<typeof setTimeout> | undefined
  const controller = new AbortController()
  async function getJSON(base: string, path: string, method = 'GET', deadlineMs = 12_000, signal?: AbortSignal): Promise<unknown> {
    const timeout = new AbortController(), abort = () => timeout.abort()
    controller.signal.addEventListener('abort', abort, { once: true })
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted || controller.signal.aborted) abort()
    const deadline = setTimeout(abort, deadlineMs)
    try {
      const headers: Record<string, string> = { accept: 'application/json' }
      if (gatewayToken) headers.authorization = `Bearer ${gatewayToken}`
      const response = await send(base + path, { method, redirect: 'error', signal: timeout.signal, headers })
      if (!response.ok) throw new Error(`Gateway HTTP ${response.status}`)
      return await boundedJSON(response)
    } finally { clearTimeout(deadline); controller.signal.removeEventListener('abort', abort); signal?.removeEventListener('abort', abort) }
  }
  async function publish(): Promise<void> {
    if (stopped) return
    let binding = currentQuota(state)
    if (binding.ignored !== quotaIgnored) {
      quotaIgnored = binding.ignored
      quotaRevision++; quotaCancel?.abort(); quotaCancel = null; quotaTask = null; quotaAt = -Infinity
      state = { ...state, quotaError: null, quotaErrorProvider: '' }
      binding = currentQuota(state)
    }
    const card = binding.card
    const update = async (item: Parameters<typeof orca.host.call<'statusBar.update'>>[1]) => {
      const json = JSON.stringify(item)
      if (barCache.get(item.id) === json) return
      try {
        await orca.host.call('statusBar.update', item)
        barCache.set(item.id, json); barErrors.delete(item.id)
      } catch (error) {
        // Full-page views can have no status bar. Keep metrics and panel delivery alive.
        const e = error as { code?: string; message?: string }
        const reason = `${e.code || 'unavailable'}: ${(e.message || 'status bar unavailable').slice(0,180)}`
        if (barErrors.get(item.id) !== reason) orca.log(`Magpie status ${item.id}: ${reason}`)
        barErrors.set(item.id, reason)
      }
    }
    const windows = quotaWindows(card), numeric = windows.filter(w => !w.text)
    const primary = (numeric.length ? numeric : windows).slice(0, 2)
    for (const [i, id] of ['quota5h', 'quota7d'].entries()) {
      const w = primary[i], label = w ? quotaWindowName(w.name, w.pool) + (card?.averaged ? ' 均值' : '') : '额度'
      await update({ id, icon: 'gauge', visible: state.showQuota && !binding.ignored && (!!w || i === 0),
        text: binding.provider ? `${i === 0 ? binding.label + ' ' : ''}${label} ${w ? quotaLabel(w) : binding.cards.length > 1 ? `${binding.cards.length} 个账号 · 见面板` : '未取得'}${w?.resetsAt ? ' ↻' + resetTime(w.resetsAt, true) : ''}${binding.error ? ' · 待更新' : ''}` : '额度 · 等待来源',
        tone: quotaTone(w?.remaining ?? null),
        tooltip: `${label} ${quotaLabel(w)}${card?.averaged && w ? `\n${w.samples}/${binding.cards.length} 个账号参与平均` : ''}${w?.resetsAt ? (card?.averaged ? '\n最早重置：' : '\n下次重置：') + resetTime(w.resetsAt) : ''}\n${binding.message}${binding.error ? '\n' + binding.error : ''}${binding.provider ? '\n点击刷新 ' + binding.label + '。' : ''}` })
    }
    const sessions = statusSessions(state), focus = state.focusedConversation
    for (let i = 0; i < 3; i++) {
      const s = sessions[i], id = i === 0 ? 'speed' : `speed${i + 1}`
      const speedError = s?.statsSource === 'antigravity-native' ? null : state.speedError
      await update({ id, icon: 'zap', visible: !!s || i === 0,
        text: s ? `${statusSessionText(s)}${cchostSource(s.provider) ? ' · ' + cchostSource(s.provider) : ''} [Token ${compactTokens(s.totalTokens)}][缓存 ${cachePercent(s.cacheHitRate)}]` : focus ? `—T/s · 当前对话${focus.session ? '暂无测速数据' : '等待会话信息'}` : '—T/s · 等待当前会话',
        tone: speedError ? 'warning' : s && s.averageTPS !== null ? speedTone(speedValue(s)) : 'neutral',
        tooltip: (`${focus ? '自动关联当前标签页' : state.focusError || '当前页面无可绑定的本机会话'}\n` + (speedError || (s ? `${sessionLabel(s)}\n${meanLabel(s)}：${rate(s.averageTPS)}\n${speedNote(s)}\n实时：${liveRate(s)}\n${s.model}\nToken：${s.totalTokens??'未提供'}（含缓存读写的累计输入输出）\n缓存命中：${cachePercent(s.cacheHitRate)}\n点击查看全部对话与速度。` : [focus?.title, conversationAgentLabel(focus), focus?.session ? '尚无匹配的测速记录。' : '', '点击查看全部对话与速度。'].filter(Boolean).join('\n')))).slice(0,256) })
    }
    popup.update(state)
    orca.panels.post('monitor.changed', panelSnapshot(state))
  }
  function focused(force = false): Promise<void> {
    if (focusTask) return focusTask
    if ((!options.focus && options.background === false) || !force && clock() - focusAt < 250) return Promise.resolve()
    focusAt = clock()
    focusTask = (async () => {
      try {
        const focus = await (options.focus || readFocus)()
        if (stopped) return
        if(focus?.session!==state.focusedConversation?.session){
          if(historyRow)state={...state,sessions:state.sessions.filter(s=>s.key!==historyRow!.key)}
          historyRow=null
        }
        state = { ...state, focusedConversation: focus, focusError: null }
        attachPreviews()
      } catch {
        if (stopped) return
        state = { ...state, focusedConversation: null, focusError: '暂未取得当前标签页，等待恢复自动关联' }
      }
      await publish()
      if(state.checkedAt&&state.focusedConversation?.session&&(!currentSession(state)||state.focusedConversation.agent==='antigravity'&&clock()-usageAt>=5000))void sessionUsage(state.baseURL,false).catch(()=>{})
    })().finally(() => { focusTask = null })
    return focusTask
  }
  async function restoreCurrentHistory(base:string):Promise<void>{
    const focus=state.focusedConversation
    if(!focus?.session)return
    const current=currentSession(state)
    if(current&&current.statsSource!=='antigravity-native')return
    if(focus.agent==='antigravity'){
      try{
        const native=await(options.native||readAntigravitySession)(focus,clock())
        if(stopped||state.baseURL!==base||state.focusedConversation?.orcaSession!==focus.orcaSession||state.focusedConversation.session!==focus.session)return
        if(native){
          historyRow=native
          state={...state,sessions:[native,...state.sessions.filter(s=>s.key!==native.key)].slice(0,MAX_SESSIONS)}
          return
        }
      }catch{ /* Keep a previously measured native summary; unsupported formats do not become zero speed. */ }
      if(current)return
    }
    const q=new URLSearchParams({period:'all',q:focus.session,via:'through',limit:'1'})
    try{
      const data=await getJSON(base,'/v1/magpie/usage/requests?'+q.toString()) as Record<string,unknown>
      const row=(Array.isArray(data.rows)?data.rows[0]:null) as Record<string,unknown>|null
      if(!row||row.session!==focus.session||typeof row.agent!=='string'||!row.agent)return
      const stats=await readSessionUsage(path=>getJSON(base,path),{agent:row.agent,session:focus.session},clock())
      if(stopped||state.baseURL!==base||state.focusedConversation?.orcaSession!==focus.orcaSession||state.focusedConversation.session!==focus.session)return
      const seed=new SessionMeter().ingest({routes:[{id:'focus-summary',agent:row.agent,session:focus.session,
        model:row.req||row.model,provider:row.provider,tries:[{model:row.model}],time:row.t,done:true}]},clock())[0]
      historyRow={...seed,key:'history:'+usageKey(seed),conversation:{session:focus.session,orcaSession:focus.orcaSession,
        title:focus.title,prompt:'',updatedAt:clock(),running:false}}
      usage.set(usageKey(historyRow),stats)
      while(usage.size>MAX_SESSIONS)usage.delete(usage.keys().next().value!)
      state={...state,sessions:attachUsage([historyRow,...state.sessions].slice(0,MAX_SESSIONS),usage)}
    }catch{ /* A missing historical session remains pending, never another chat's statistics. */ }
  }
  function sessionUsage(base:string,force:boolean):Promise<void>{
    if(usageTask)return usageTask
    usageAt=clock()
    const requestedFocus=state.focusedConversation?.session
    usageTask=(async()=>{
      await restoreCurrentHistory(base)
      if(state.speedError&&currentSession(state)?.statsSource==='antigravity-native'){await publish();return}
      const targets=new Map(state.sessions.filter(s=>s.statsSource!=='antigravity-native').map(s=>[usageKey(s),s]))
      for(const key of usage.keys())if(!targets.has(key))usage.delete(key)
      const tasks=[...targets.values()].filter(s=>{
        const old=usage.get(usageKey(s))
        return force||!old||clock()-old.checkedAt>=(s.active||s.conversation?.running||s.session===state.focusedConversation?.session?5000:60000)
      }).sort((a,b)=>Number(b.session===state.focusedConversation?.session)-Number(a.session===state.focusedConversation?.session))
      let cursor=0
      async function run(){
        while(cursor<tasks.length&&!stopped&&state.baseURL===base){
          const s=tasks[cursor++],key=usageKey(s)
          let stats:SessionUsage
          try{stats=await readSessionUsage(path=>getJSON(base,path),s,clock())}
          catch{stats={...(usage.get(key)||{averageTPS:null,output:0,milliseconds:0,samples:0,requests:s.requests,startedAt:null}),checkedAt:clock(),error:'网关会话汇总暂不可用，未在插件中重算历史。'}}
          if(stopped||state.baseURL!==base)return
          if(state.sessions.some(s=>usageKey(s)===key)){
            usage.set(key,stats)
            while(usage.size>MAX_SESSIONS)usage.delete(usage.keys().next().value!)
            state={...state,sessions:attachUsage(state.sessions,usage)}
          }
        }
      }
      await Promise.all([run(),run()]);await publish()
    })().finally(()=>{
      usageTask=null
      if(!stopped&&state.baseURL===base&&state.focusedConversation?.session!==requestedFocus&&state.focusedConversation?.session&&!currentSession(state))void sessionUsage(base,false).catch(()=>{})
    })
    return usageTask
  }
  function attachPreviews(): void {
    const focus=state.focusedConversation
    state = { ...state, sessions: state.sessions.map(session => ({ ...session, conversation: previews.get(session.session)
      || (session.session===focus?.session?{session:session.session,orcaSession:focus.orcaSession,title:focus.title,prompt:'',updatedAt:clock()}:undefined) })) }
  }
  function conversations(): Promise<void> {
    if (conversationTask) return conversationTask
    conversationAt = clock()
    const base = state.baseURL, ids = state.sessions.map(s => s.session)
    conversationTask = (async () => {
      try {
        const rows = await (options.conversations || readConversations)(ids)
        if (stopped || state.baseURL !== base) return
        const next = new Map<string, ConversationPreview>()
        for (const row of rows) {
          const old = next.get(row.session)
          if (!old || row.updatedAt > old.updatedAt) next.set(row.session, row)
        }
        previews = next
        state = { ...state, conversationError: null }
        attachPreviews()
      } catch {
        if (!stopped && state.baseURL === base) state = { ...state, conversationError: '暂未读取到 Orca 对话标题和最近提问；测速继续更新。' }
      }
      await publish()
    })().finally(() => { conversationTask = null })
    return conversationTask
  }
  function quotas(base: string, force: boolean): Promise<void> {
    if (!state.showQuota || currentQuota(state).ignored) return Promise.resolve()
    if (quotaTask) return quotaTask
    const revision = quotaRevision, cancel = new AbortController()
    quotaCancel = cancel
    const current = () => !stopped && state.baseURL === base && state.showQuota && !currentQuota(state).ignored && quotaRevision === revision
    quotaAt = clock()
    const task = (async () => {
      function accept(payload: unknown, partial = false, target?: string): void {
        if (!current()) return
        const parsed = parseCards(payload)
        const selected = target ?? currentQuota({ ...state, cards: parsed }).provider
        if (!selected && !state.focusedConversation && !parsed.length) throw new Error('quota unavailable')
        const matches = parsed.filter(c => c.provider === selected)
        function replaceSelected(replacements: typeof parsed): typeof parsed {
          let inserted = false
          const result = (partial ? state.cards : parsed).flatMap(card => {
            if (card.provider !== selected) return [card]
            if (inserted) return []
            inserted = true; return replacements
          })
          if (!inserted) result.push(...replacements)
          return result
        }
        if (selected && (!matches.length || matches.every(c => c.error))) {
          const kept = state.cards.filter(c => c.provider === selected && !c.error)
          state = { ...state, cards: replaceSelected(kept.length ? kept : matches) }
          if (partial || matches.length) throw new Error('quota unavailable')
        } else {
          state = { ...state, cards: partial ? replaceSelected(matches) : parsed }
        }
        if (!partial || currentQuota(state).provider === selected) {
          state = { ...state, quotaErrorProvider: selected,
            quotaError: matches.some(c => c.error) ? `${quotaSelection(parsed, selected).label} 部分账号额度暂不可用。` : null }
        }
      }
      try {
        // Show kept readings first; a vendor refresh must not blank usable quota data.
        accept(await getJSON(base, '/v1/magpie/quotas?kept=1', 'GET', 12_000, cancel.signal))
        await publish()
      } catch {
        if (current()) state = { ...state, quotaErrorProvider: '', quotaError: '额度暂未更新，已有读数保留。请检查网关。' }
      }
      const { provider: selected, label } = currentQuota(state)
      if (force && current() && selected) try {
        // Resolve auto mode before refreshing; never send a refresh-all request.
        accept(await getJSON(base, '/v1/magpie/quotas/refresh?provider=' + encodeURIComponent(selected), 'POST', 35_000, cancel.signal), true, selected)
      } catch {
        if (current() && selected === currentQuota(state).provider)
          state = { ...state, quotaErrorProvider: selected, quotaError: `${label} 刷新失败，保留上次成功读数。` }
      }
      if (current()) await publish()
    })().finally(() => { if (quotaTask === task) { quotaTask = null; quotaCancel = null } })
    quotaTask = task
    return task
  }
  async function refresh(force = false): Promise<Snapshot> {
    if (pending) { await pending; if (!force) return state }
    let quotaBase: string | undefined
    pending = (async () => {
      try {
        const settings = await orca.settings.get(), base = gatewayBaseURL(settings.baseURL)
        const tokenEnv = typeof settings.bearerTokenEnv === 'string' ? settings.bearerTokenEnv.trim() : ''
        if (tokenEnv && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(tokenEnv)) throw new Error('Invalid token environment variable')
        const token = tokenEnv ? process.env[tokenEnv]?.trim() : ''
        if (tokenEnv && !token || token && /[\r\n\0]/.test(token)) throw new Error('Gateway token environment variable unavailable')
        const gatewayChanged = state.baseURL !== base || gatewayToken !== (token || '')
        gatewayToken = token || ''
        const showQuota = settings.showQuota !== false
        const quotaProvider = typeof settings.quotaProvider === 'string' && settings.quotaProvider.trim() ? settings.quotaProvider.trim().slice(0, 256) : 'auto'
        const ignoredQuotaModels = parseIgnoredQuotaModels(settings.ignoredQuotaModels)
        if (gatewayChanged || state.showQuota !== showQuota || state.quotaProvider !== quotaProvider
            || JSON.stringify(state.ignoredQuotaModels || []) !== JSON.stringify(ignoredQuotaModels)) {
          quotaRevision++; quotaCancel?.abort(); quotaCancel = null; quotaTask = null; quotaAt = -Infinity
          state = { ...state, quotaError: null, quotaErrorProvider: '' }
        }
        if (gatewayChanged) { meter = new SessionMeter(); previews.clear(); usage.clear(); historyRow=null; state = { ...emptySnapshot(), selectedSession: state.selectedSession }; quotaAt = conversationAt = usageAt = -Infinity }
        state = { ...state, baseURL: base, showQuota, quotaProvider, ignoredQuotaModels, cards: showQuota ? state.cards : [] }
        if (showQuota) quotaBase = base
        void focused(force).catch(() => {})
        // Resolve the focused model before starting any quota requests.
        try {
          const payload = await getJSON(base, '/v1/magpie/trace')
          const all=meter.ingest(payload,clock())
          if(historyRow&&historyRow.session===state.focusedConversation?.session&&!all.some(s=>!s.subagent&&s.session===historyRow!.session))all.unshift(historyRow)
          const sessions=all.slice(0,MAX_SESSIONS)
          state = { ...state, sessions: attachUsage(sessions,usage), omittedSessions:Math.max(0,all.length-MAX_SESSIONS), speedError: null, checkedAt: clock() }
          attachPreviews()
          if(force||clock()-usageAt>=5000)void sessionUsage(base,force).catch(()=>{})
          if (force || clock() - conversationAt >= 1000) void conversations().catch(() => {})
        } catch { state = { ...state, speedError: '无法读取网关，会话速度已暂停更新', checkedAt: clock() } }
      } catch { state = { ...state, checkedAt: clock(), speedError: '请检查网关地址和认证环境变量设置', quotaErrorProvider: '', quotaError: state.showQuota ? '无法连接网关' : null } }
      await publish()
      return state
    })()
    try { await pending } finally { pending = null }
    if (focusTask) await focusTask
    if (state.focusedConversation?.agent==='antigravity'&&(force||clock()-usageAt>=5000))await sessionUsage(state.baseURL,force)
    if (force && quotaBase && quotaBase === state.baseURL) {
      if (state.quotaProvider === 'auto' && state.focusedConversation?.session && !currentSession(state))
        await restoreCurrentHistory(quotaBase)
      await quotaTask
      await quotas(quotaBase, true)
    } else if (quotaBase && quotaBase === state.baseURL && clock() - quotaAt >= 30_000)
      void quotas(quotaBase, false).catch(() => {})
    if (force && usageTask) await usageTask
    return panelSnapshot(state)
  }
  orca.panels.handle('monitor.get', async () => {
    if (!state.checkedAt) await refresh()
    await Promise.all([quotaTask, conversationTask, focusTask])
    return panelSnapshot(state)
  })
  orca.panels.handle('monitor.refresh', () => refresh(true))
  orca.panels.handle('monitor.quota', async ({ enabled, provider }) => {
    if (enabled !== undefined && typeof enabled !== 'boolean' || provider !== undefined && (typeof provider !== 'string' || !provider.trim() || provider.length > 256))
      throw Object.assign(new Error('额度设置无效'), { code: 'invalid_params' })
    writingSettings = true
    try {
      if (provider !== undefined) await orca.settings.set('quotaProvider', provider.trim())
      if (enabled !== undefined) await orca.settings.set('showQuota', enabled)
    } finally { writingSettings = false }
    return refresh(true)
  })
  orca.panels.handle('monitor.select', async ({ session }) => {
    if (session && !state.sessions.some(s => s.key === session)) throw Object.assign(new Error('会话已不在列表中'), { code: 'invalid_params' })
    state = { ...state, selectedSession: session }
    await orca.storage.set('selectedSessionV2', session)
    await publish(); return panelSnapshot(state)
  })
  orca.commands.register('magpie.refresh', async () => {
    const updated = await refresh(true)
    return `Magpie：${updated.sessions.length} 个会话，${updated.cards.length} 张额度卡片。详情见右侧 Magpie 面板。`
  })
  orca.commands.register('magpie.sessions', async () => { await popup.show(state) })
  orca.panels.handle('monitor.popup', async () => { await popup.show(state); return { opened: true } })
  const changed = orca.settings.onDidChange(() => { if (!writingSettings) void refresh(true).catch(() => {}) })
  async function tick(): Promise<void> {
    try { await refresh() } catch { if (!stopped) orca.log('Magpie monitor update failed') }
    if (!stopped) {
      let interval = 1
      try { interval = Number(await orca.settings.get('intervalSeconds')) || 1 } catch {}
      timer = setTimeout(() => { void tick() }, Math.min(10, Math.max(1, interval)) * 1000)
    }
  }
  async function focusTick(): Promise<void> {
    try { await focused() } catch {}
    if (!stopped) focusTimer = setTimeout(() => { void focusTick() }, 500)
  }
  const stopFocusWatch = options.background !== false ? watchFocus(() => {
    if(stopped)return
    if(focusWakeTimer)clearTimeout(focusWakeTimer)
    focusWakeTimer=setTimeout(()=>{void focused(true).catch(()=>{})},25)
  }) : ()=>{}
  if (options.background !== false) void focusTick()
  if (options.background !== false) void orca.storage.get('selectedSessionV2').then(value => {
    if (typeof value === 'string') state.selectedSession = value
    if (!stopped) void tick()
  }).catch(() => { if (!stopped) void tick() })
  return () => { stopped = true; controller.abort(); popup.close(); if (timer) clearTimeout(timer); if (focusTimer) clearTimeout(focusTimer); if(focusWakeTimer)clearTimeout(focusWakeTimer);stopFocusWatch();changed.dispose() }
}
export default function activate(orca: OrcaWorkerApi): void { stop = activateMonitor(orca) }
export function deactivate(): void { stop?.(); stop = undefined }
