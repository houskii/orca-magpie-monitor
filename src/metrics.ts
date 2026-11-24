import type { QuotaCard, QuotaWindow, Session } from './protocol'
export type Route = {
  id: string; agent: string; session: string; subagent: string; folder: string; model: string; requestedModel: string; provider: string; quotaProvider: string;
  done: boolean; status: number; canceled: boolean; time: number; contentAt: number; estimatedTokens: number | null;
  output: number; reasoning: number; ms: number; ttft: number; firstText: number; firstReasoning: number;
  reasoningHidden: boolean; flow: number;
}
type RecordValue = Record<string, unknown>
const object = (v: unknown): RecordValue => v !== null && typeof v === 'object' && !Array.isArray(v) ? v as RecordValue : {}
const number = (v: unknown): number => typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0
const word = (v: unknown): string => typeof v === 'string' ? v.slice(0, 256).replace(/[\r\n\0]/g, ' ') : ''
const time = (v: unknown): number => typeof v === 'string' && Number.isFinite(Date.parse(v)) ? Date.parse(v) : 0
export function gatewayBaseURL(value: unknown): string {
  const url = new URL(typeof value === 'string' ? value : 'http://127.0.0.1:3425')
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
  if (!(url.protocol === 'https:' || url.protocol === 'http:' && loopback)
      || url.username || url.password || url.search || url.hash)
    throw new Error('请使用本机 HTTP 网关或 HTTPS 网关地址；认证信息请通过环境变量提供')
  return url.origin + url.pathname.replace(/\/+$/, '')
}
// A balance expression can explicitly label a percentage as used and pair it
// with a reset. Unlabelled percentages may instead mean remaining or credits.
function balanceWindows(value: unknown, balance: string): QuotaWindow[] {
  // Some Magpie versions only export the formatted balance on the gateway.
  // Accept just the labels and syntax of the explicit balance expression.
  const parts = Array.isArray(value) && value.length ? value.slice(0, 50).map(object) :
    balance.split(' · ').flatMap((part): RecordValue[] => {
      const match = /^(.+ (?:used|reset)) (\S+)$/.exec(part)
      if (!match) return []
      const [, label, text] = match
      return [{ label, text, percent: /^\d+(?:\.\d+)?%$/.test(text) ? Number(text.slice(0, -1)) : null }]
    })
  const resets = new Map(parts.filter(p => !p.error).map(p => [word(p.label), word(p.text)]))
  const windows = parts.flatMap(p => {
    const name = word(p.label).match(/^(.+) used$/)?.[1], used = p.percent
    if (!name || p.error || typeof used !== 'number' || !Number.isFinite(used) || used < 0) return []
    const reset = resets.get(name + ' reset')
    return [{ name, used, remaining: Math.max(0, 100 - used),
      resetsAt: reset && time(reset) ? reset : null, display: '', text: false }]
  })
  return windows
}
export function parseCards(payload: unknown): QuotaCard[] {
  const data = object(payload).data
  if (!Array.isArray(data)) throw new Error('网关额度接口格式不正确')
  const counts = new Map<string, number>()
  return data.slice(0, 100).map(value => {
    const card = object(value), provider = word(card.provider)
    const count = (counts.get(provider) || 0) + 1; counts.set(provider, count)
    const balance = word(card.balance)
    const balanceQuota = Array.isArray(card.windows) && card.windows.length ? [] : balanceWindows(card.balanceParts, balance)
    return { key: `${provider}:${count}`, provider, name: (word(card.name) || provider) + (count > 1 ? ` · 账户 ${count}` : ''),
      balance: balanceQuota.length ? '' : balance,
      error: typeof card.error === 'string' && card.error ? '上游额度读取失败，请在网关中查看详情' : null,
      readAt: time(card.readAt) ? String(card.readAt) : null,
      windows: balanceQuota.length ? balanceQuota : (Array.isArray(card.windows) ? card.windows : []).slice(0, 50).map(value => {
        const w = object(value), hasBalance = typeof w.balance === 'number' && Number.isFinite(w.balance)
        const text = w.text === true || w.unlimited === true || hasBalance
        const used = !text && typeof w.used === 'number' && Number.isFinite(w.used) && w.used >= 0 ? w.used : null
        const remaining = text ? null : typeof w.remaining === 'number' && Number.isFinite(w.remaining) && w.remaining >= 0
          ? Math.min(100, w.remaining) : used === null ? null : Math.max(0, 100 - used)
        return { name: word(w.name), pool: word(w.pool), used, remaining,
          resetsAt: time(w.resetsAt) ? String(w.resetsAt) : null,
          display: w.unlimited === true ? '不限额' : word(w.display) || (hasBalance ? `${w.balance} ${word(w.unit)}`.trim() : ''), text }
      }) }
  })
}
export function parseRoutes(payload: unknown): Route[] {
  const routes = object(payload).routes
  if (!Array.isArray(routes)) throw new Error('网关路由接口格式不正确')
  return routes.slice(-500).map(value => {
    const r = object(value)
    const tries = Array.isArray(r.tries) ? r.tries : [], lastTry = object(tries[tries.length - 1])
    const seats = Array.isArray(r.order) ? r.order : []
    const seat = object(seats.find(value => object(value).id === lastTry.id))
    const provider = word(seat.provider) || word(r.provider)
    // The chosen account's agent is the quota provider (e.g. openai -> codex).
    // Use the answering try, so a routing-group fallback does not keep its original provider.
    const quotaProvider = seat.kind === 'account' ? word(seat.agent) || provider : provider
    return { id: String(r.id ?? ''), agent: word(r.agent), session: word(r.session),
      subagent: word(r.subagentId) || word(r.sub), folder: word(r.folder), model: word(lastTry.model) || word(r.model), requestedModel: word(r.model), provider, quotaProvider,
      done: r.done === true, status: number(r.status), canceled: r.canceled === true, time: time(r.time),
      contentAt: number(r.contentAt), estimatedTokens: number(r.estTok) > 0 ? number(r.estTok) : null,
      output: number(r.out), reasoning: number(r.reasoning), ms: number(r.ms), ttft: number(r.ttft),
      firstText: number(r.firstText), firstReasoning: number(r.firstReasoning),
      reasoningHidden: r.reasoningHidden === true, flow: number(r.flow) }
  }).filter(r => r.id)
}
export function sessionKey(r: Route): string {
  // Never group unidentified calls by model: concurrent chats can share it.
  return JSON.stringify([r.agent, r.session || `request:${r.id}`, r.subagent])
}
export const isOrca = (agent: string): boolean => /^orca(?:_|-|\b)/i.test(agent)
type Point = { at: number; tokens: number }
export class SessionMeter {
  private points = new Map<string, Point[]>()
  private pid: unknown
  ingest(payload: unknown, at: number): Session[] {
    const pid = object(payload).pid
    if (this.pid !== undefined && pid !== undefined && this.pid !== pid) this.points.clear()
    this.pid = pid
    const routes = parseRoutes(payload), active = new Set(routes.filter(r => !r.done).map(r => r.id))
    for (const id of this.points.keys()) if (!active.has(id)) this.points.delete(id)
    for (const r of routes) if (!r.done && r.estimatedTokens !== null) {
      let points = this.points.get(r.id) || []
      if (points.length && (r.estimatedTokens < points[points.length-1].tokens || at-points[points.length-1].at > 10000)) points=[]
      points.push({ at, tokens:r.estimatedTokens })
      while(points.length>4 || points.length>1 && points[1].at<=at-3000)points.shift()
      this.points.set(r.id,points)
    }
    return this.sessions(at,routes)
  }
  private sessions(at: number, routes:Route[]): Session[] {
    const groups = new Map<string, { value: Session; decoded: number; duration: number; latest: number; liveKnown: boolean }>()
    for (const r of routes) {
      const key = sessionKey(r)
      let group = groups.get(key)
      if (!group) {
        group = { value: { key, session: r.session || `未标识请求 ${r.id}`, agent: r.agent, subagent: r.subagent,
          folder: r.folder, model: r.model, requestedModel: r.requestedModel, provider: r.provider, quotaProvider: r.quotaProvider, active: 0, liveTPS: null, runningTPS: null, averageTPS: null,
          lastTPS: null, measuredRequests: 0, requests: 0, output: 0, lastAt: 0, measuredOutput: 0, generationMs: 0, startedAt: null, statsSource: 'pending', statsError: null, state: 'idle' },
          decoded: 0, duration: 0, latest: 0, liveKnown: true }
        groups.set(key, group)
      }
      const value = group.value
      value.requests++; value.output += r.output
      if (r.time >= value.lastAt) Object.assign(value, { lastAt: r.time, model: r.model, requestedModel: r.requestedModel, provider: r.provider, quotaProvider: r.quotaProvider, folder: r.folder })
      if (!r.done) {
        value.active++
        const points = this.points.get(r.id) || [], first = points[0], last = points[points.length - 1]
        const measurable = first && last && last.at - first.at >= 500 && r.estimatedTokens !== null
        if (!measurable) group.liveKnown = false
        else value.liveTPS = (value.liveTPS || 0) + Math.max(0, last.tokens - first.tokens) * 1000 / (last.at - first.at)
        if (r.contentAt && at - r.contentAt < 5000) value.state = measurable ? 'streaming' : 'sampling'
        else if (value.state === 'idle') value.state = 'waiting'
      }
    }
    return [...groups.values()].map(g => {
      if (!g.liveKnown || !g.value.active) { g.value.liveTPS = null; g.value.runningTPS = null }
      return g.value
    }).sort((a, b) => Number(b.active > 0) - Number(a.active > 0) || b.lastAt - a.lastAt)
  }
}
export function selectedSession(sessions: Session[], key: string): Session | undefined {
  return key ? sessions.find(s => s.key === key) : undefined
}
export const formatTPS = (value: number | null): string => value === null ? '—' : value.toFixed(1)

function averageQuota(cards: QuotaCard[], provider: string, label: string): QuotaCard | undefined {
  const groups = new Map<string, { name: string; pool: string; total: number; samples: number; resets: string[] }>()
  for (const card of cards) {
    if (card.error) continue
    const seen = new Set<string>()
    for (const w of card.windows) {
      const key = JSON.stringify([w.pool || '', w.name])
      if (w.text || w.remaining === null || !Number.isFinite(w.remaining) || seen.has(key)) continue
      seen.add(key)
      const group = groups.get(key) || { name: w.name, pool: w.pool || '', total: 0, samples: 0, resets: [] }
      group.total += w.remaining; group.samples++
      if (w.resetsAt) group.resets.push(w.resetsAt)
      groups.set(key, group)
    }
  }
  if (!groups.size) return undefined
  return { key: `average:${provider}`, provider, name: `${label} · ${cards.length} 个账号均值`, averaged: true,
    error: null, readAt: null, windows: [...groups.values()].map(group => {
      const remaining = Math.round(group.total / group.samples * 10) / 10
      return { name: group.name, pool: group.pool, used: 100 - remaining, remaining, text: false, samples: group.samples,
        display: `${group.samples}/${cards.length} 个账号参与平均`,
        resetsAt: group.resets.sort((a, b) => Date.parse(a) - Date.parse(b))[0] || null }
    }) }
}
export function cchostSource(provider: string): string | undefined {
  if (provider === 'claude-cchost') return 'cchost · Claude'
  if (provider === 'gemini-cchost') return 'cchost · Gemini'
}

export function quotaSelection(cards: QuotaCard[], selection = 'auto', sessionProvider?: string) {
  const automatic = !selection || selection === 'auto'
  const first = cards.find(c => !c.error && (c.balance || c.windows.some(w => w.remaining !== null || w.display)))
    || cards.find(c => !c.error) || cards[0]
  const provider = automatic ? sessionProvider ?? first?.provider ?? '' : selection
  const matches = cards.filter(card => card.provider === provider)
  const label = cchostSource(provider) || matches[0]?.name || provider || '网关'
  const card = matches.length === 1 ? matches[0] : averageQuota(matches, provider, label)
  const message = automatic && sessionProvider === '' ? '等待当前会话的网关请求来确认额度来源。'
    : matches.length > 1 ? `${label} 共 ${matches.length} 个账号，同名额度窗口按有效读数取算术平均。下方保留各账号明细。`
    : matches.length ? `${label} 的账号额度由使用这个账号的所有会话共享。`
    : `尚未读取到 ${label} 额度，请确认网关已提供该来源的额度查询。`
  return { cards: matches, card, label, message, provider, automatic }
}
