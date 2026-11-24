import { assert, hostError, mockHost, mountWorker, test } from 'orca/testing'
import { activateMonitor } from './worker'
import type { OrcaWorkerApi } from 'orca/worker'
import { instant, rawRoute, sampleSnapshot } from './fixtures'
import { popupData } from './popup'
import type { FocusedConversation } from './protocol'

const withUsage=(send:typeof fetch):typeof fetch=>async(input,init)=>{
 const url=String(input)
 if(url.includes('/usage/requests')){
  const q=new URL(url).searchParams,session=q.get('q')||'',agent=q.get('agent')||''
  const m=/^chat-(\d)$/.exec(session),speed=m?[10,40,100,200][Number(m[1])]:100
  return Response.json({total:1,decode_out:speed*2,decode_ms:2000,decode_n:1,rows:[{agent,session,t:new Date(instant).toISOString()}]})
 }
 return send(input,init)
}

test('ignored models skip every quota request from startup and resume for another model', async () => {
  let focus: FocusedConversation = { orcaSession: 'focused', session: 'ignored', workspace: 'workspace', title: '当前对话' }
  const requested: string[] = []
  let stop: (() => void) | undefined
  const send: typeof fetch = async input => {
    const url = String(input); requested.push(url)
    return Response.json(url.includes('/trace') ? { routes: [
      rawRoute(1, 'ignored', { model: 'gateway/GPT-6-sol', provider: 'wallet' }),
      rawRoute(2, 'allowed', { model: 'claude-opus', provider: 'wallet' }),
    ] } : { data: [{ provider: 'wallet', balance: '$42' }] })
  }
  const module = { default(orca: OrcaWorkerApi) { stop = activateMonitor(orca, {
    send: withUsage(send), background: false, conversations: async () => [], focus: async () => focus,
  }) }, deactivate() { stop?.() } }
  const host = mockHost({ capabilities: ['settings:own', 'storage:own'], settings: { ignoredQuotaModels: 'gpt, gemini', quotaProvider: 'wallet' } })
  const worker = await mountWorker(module, { host, commands: ['magpie.refresh', 'magpie.sessions'] })
  await worker.request('monitor.get')
  const ignored = await worker.request('monitor.refresh')
  assert.equal(requested.some(url => url.includes('/quotas')), false)
  assert.deepEqual(ignored.cards, []); assert.equal(ignored.quotaError, null)
  assert.equal(ignored.sessions[0].averageTPS, 100)
  const bars = host.callsOf('statusBar.update') as { id: string; visible: boolean }[]
  for (const id of ['quota5h', 'quota7d']) assert.equal(bars.filter(c => c.id === id).at(-1)?.visible, false)
  focus = { ...focus, session: 'allowed' }
  const allowed = await worker.request('monitor.refresh')
  assert.equal(popupData(allowed).quotas[0].value, '$42')
  assert.ok(requested.some(url => url.endsWith('/quotas/refresh?provider=wallet')))
  await worker.deactivate()
})

test('switching to an ignored model cancels pending quota reads and discards their late results', async () => {
  let focus: FocusedConversation = { orcaSession: 'focused', session: 'allowed', workspace: 'workspace', title: '当前对话' }
  let resolveQuota: ((r: Response) => void) | undefined
  let quotaSignal: AbortSignal | null | undefined
  let stop: (() => void) | undefined
  const send: typeof fetch = async (input, init) => {
    if (String(input).includes('/trace')) return Response.json({ routes: [
      rawRoute(1, 'allowed', { model: 'claude-opus' }), rawRoute(2, 'ignored', { model: 'gemini-4-pro' }),
    ] })
    quotaSignal = init?.signal
    return new Promise<Response>(resolve => { resolveQuota = resolve })
  }
  const module = { default(orca: OrcaWorkerApi) { stop = activateMonitor(orca, {
    send: withUsage(send), background: false, conversations: async () => [], focus: async () => focus,
  }) }, deactivate() { stop?.() } }
  const worker = await mountWorker(module, { host: mockHost({ capabilities: ['settings:own', 'storage:own'], settings: { ignoredQuotaModels: 'gemini' } }), commands: ['magpie.refresh', 'magpie.sessions'] })
  const initial = worker.request('monitor.get')
  for (let i = 0; !resolveQuota && i < 250; i++) await new Promise(resolve => setTimeout(resolve, 1))
  assert.ok(resolveQuota)
  focus = { ...focus, session: 'ignored' }
  const changed = await worker.request('monitor.refresh')
  assert.equal(quotaSignal?.aborted, true)
  assert.deepEqual(changed.cards, [])
  resolveQuota!(Response.json({ data: [{ provider: 'openai', balance: '$999' }] }))
  await initial
  const result = await worker.request('monitor.get')
  assert.deepEqual(result.cards, []); assert.equal(result.quotaError, null)
  await worker.deactivate()
})

test('auto discovers the gateway provider and refreshes only its actual ID', async () => {
  const posts: string[] = []
  let stop: (() => void) | undefined
  const cards = [
    { provider: 'offline-source', error: 'unavailable' },
    { provider: 'credits/source', name: 'Credits', balance: '$42.00' },
    { provider: 'another-source', windows: [{ name: 'week', used: 70 }] },
  ]
  const send: typeof fetch = async (input, init) => {
    const url = String(input)
    if (url.includes('/trace')) return Response.json({ routes: [] })
    if (init?.method === 'POST') { posts.push(url); return Response.json({ data: [cards[1]] }) }
    return Response.json({ data: cards })
  }
  const module = { default(orca: OrcaWorkerApi) { stop = activateMonitor(orca, { send, background: false, conversations: async () => [] }) }, deactivate() { stop?.() } }
  const worker = await mountWorker(module, { host: mockHost({ capabilities: ['settings:own', 'storage:own'] }), commands: ['magpie.refresh', 'magpie.sessions'] })
  await worker.request('monitor.get')
  const result = await worker.request('monitor.refresh')
  assert.equal(result.quotaProvider, 'auto')
  assert.equal(result.quotaError, null)
  assert.equal(popupData(result).quotas[0].value, '$42.00')
  assert.deepEqual(posts, ['http://127.0.0.1:3425/v1/magpie/quotas/refresh?provider=credits%2Fsource'])
  assert.equal(result.cards[1].provider, 'credits/source')
  await worker.deactivate()
})

test('auto without discovered quota sources never sends a refresh-all POST', async () => {
  let stop: (() => void) | undefined
  const methods: string[] = []
  const send: typeof fetch = async (input, init) => {
    methods.push(init?.method || 'GET')
    return Response.json(String(input).includes('/trace') ? { routes: [] } : { data: [] })
  }
  const module = { default(orca: OrcaWorkerApi) { stop = activateMonitor(orca, { send, background: false, conversations: async () => [] }) }, deactivate() { stop?.() } }
  const worker = await mountWorker(module, { host: mockHost({ capabilities: ['settings:own', 'storage:own'] }), commands: ['magpie.refresh', 'magpie.sessions'] })
  await worker.request('monitor.get')
  const result = await worker.request('monitor.refresh')
  assert.ok(result.quotaError)
  assert.equal(methods.includes('POST'), false)
  await worker.deactivate()
})

test('compatible HTTPS gateway prefixes and environment authentication apply to every request', async () => {
  const variable = 'ORCA_MONITOR_TEST_BEARER', previous = process.env[variable]
  process.env[variable] = 'fixture-bearer-value'
  const requests: string[] = []
  let stop: (() => void) | undefined
  const send: typeof fetch = async (input, init) => {
    const url = String(input); requests.push(url)
    assert.ok(url.startsWith('https://gateway.example.com/monitor/v1/magpie/'))
    assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer fixture-bearer-value')
    assert.equal(init?.redirect, 'error')
    if (url.includes('/trace')) return Response.json({ routes: [rawRoute(1)] })
    if (url.includes('/usage/requests')) return Response.json({ total: 1, decode_out: 100, decode_ms: 1000, decode_n: 1,
      rows: [{ agent: 'orca_desktop', session: 'chat-a', t: new Date(instant).toISOString() }] })
    return Response.json({ data: [{ provider: 'wallet', balance: '$12' }] })
  }
  const module = { default(orca: OrcaWorkerApi) { stop = activateMonitor(orca, { send, background: false, conversations: async () => [] }) }, deactivate() { stop?.() } }
  const host = mockHost({ capabilities: ['settings:own', 'storage:own'], settings: {
    baseURL: 'https://gateway.example.com/monitor/', bearerTokenEnv: variable,
  } })
  const worker = await mountWorker(module, { host, commands: ['magpie.refresh', 'magpie.sessions'] })
  try {
    await worker.request('monitor.get')
    const result = await worker.request('monitor.refresh')
    assert.equal(result.speedError, null); assert.equal(result.quotaError, null)
    assert.equal(result.sessions[0].averageTPS, 100)
    assert.ok(requests.some(url => url.includes('/usage/requests')))
    assert.ok(requests.some(url => url.endsWith('/quotas/refresh?provider=wallet')))
    assert.equal(JSON.stringify([result, host.callsOf('statusBar.update')]).includes('fixture-bearer-value'), false)
  } finally {
    await worker.deactivate()
    if (previous === undefined) delete process.env[variable]; else process.env[variable] = previous
  }
})

test('missing configured authentication stops requests before contacting a gateway', async () => {
  let stop: (() => void) | undefined
  let requests = 0
  const module = { default(orca: OrcaWorkerApi) { stop = activateMonitor(orca, {
    send: async () => { requests++; throw Error('must not contact gateway') }, background: false, conversations: async () => [],
  }) }, deactivate() { stop?.() } }
  const worker = await mountWorker(module, { host: mockHost({ capabilities: ['settings:own', 'storage:own'], settings: {
    bearerTokenEnv: 'ORCA_MONITOR_TEST_MISSING_BEARER', baseURL: 'https://gateway.example.com',
  } }), commands: ['magpie.refresh', 'magpie.sessions'] })
  const result = await worker.request('monitor.get')
  assert.ok(result.speedError?.includes('认证'))
  assert.equal(requests, 0)
  await worker.deactivate()
})

test('worker normalizes Magpie metrics and persists chosen session', async () => {
  const requested: string[] = []
  const send: typeof fetch = async input => {
    const url = String(input); requested.push(url)
    return Response.json(url.includes('/trace') ? { routes: [rawRoute(1)] } : { data: [{ provider: 'example-provider', windows: [{ name: '5 hours', used: 8 }] }] })
  }
  let stop: (() => void) | undefined
  const module = { default(orca: OrcaWorkerApi) { stop = activateMonitor(orca, { send:withUsage(send), clock: () => instant, background: false, conversations: async () => [] }) }, deactivate() { stop?.() } }
  const host = mockHost({ capabilities: ['settings:own', 'storage:own'], settings: { baseURL: 'http://127.0.0.1:3425' } })
  const worker = await mountWorker(module, { host, commands: ['magpie.refresh', 'magpie.sessions'] })
  const first = await worker.request('monitor.get')
  assert.equal(first.cards[0].windows[0].used, 8)
  assert.equal(first.sessions.length, 1)
  const chosen = await worker.request('monitor.select', { session: first.sessions[0].key })
  assert.equal(chosen.selectedSession, first.sessions[0].key)
  assert.equal(host.data().storage.selectedSessionV2, chosen.selectedSession)
  assert.ok(requested.every(url => url.startsWith('http://127.0.0.1:3425/v1/magpie/')))
  assert.ok(host.callsOf('statusBar.update').length >= 2)
  assert.ok(host.callsOf('statusBar.update').some(call => JSON.stringify(call).includes('example-provider 5h 余92%')))
  assert.deepEqual(worker.refusals, [])
  await worker.deactivate()
})
test('worker attaches exact conversation previews and keeps speed available if titles fail', async () => {
  let stop: (() => void) | undefined, fail = false
  const send: typeof fetch = async input => Response.json(String(input).includes('/trace')
    ? { routes: [rawRoute(1, 'native-thread')] }
    : { data: [{ provider: 'example-provider', windows: [{ name: '5 hours', used: 2 }] }] })
  const module = { default(orca: OrcaWorkerApi) {
    stop = activateMonitor(orca, { send:withUsage(send), background: false, conversations: async ids => {
      assert.deepEqual(ids, ['native-thread'])
      if (fail) throw Error('database busy')
      return [{ session: 'native-thread', orcaSession: 'orca-native', title: '检查用量', prompt: '能看到具体对话吗？', updatedAt: 100 }]
    } })
  }, deactivate() { stop?.() } }
  const host = mockHost({ capabilities: ['settings:own', 'storage:own'] })
  const worker = await mountWorker(module, { host, commands: ['magpie.refresh', 'magpie.sessions'] })
  await worker.request('monitor.get')
  const result = await worker.request('monitor.refresh')
  assert.equal(result.sessions[0].conversation?.title, '检查用量')
  assert.equal(result.sessions[0].conversation?.prompt, '能看到具体对话吗？')
  assert.equal(result.sessions[0].averageTPS, 100)
  await worker.request('monitor.select', { session: result.sessions[0].key })
  assert.ok(host.callsOf('statusBar.update').some(call => JSON.stringify(call).includes('—T/s · 等待当前会话')))
  fail = true
  await worker.request('monitor.refresh')
  const stale = await worker.request('monitor.get')
  assert.ok(stale.conversationError)
  assert.equal(stale.speedError, null)
  assert.equal(stale.sessions[0].conversation?.title, '检查用量')
  assert.equal(stale.sessions[0].averageTPS, 100)
  assert.deepEqual(worker.refusals, [])
  await worker.deactivate()
})
test('failed Example refresh preserves the kept reading and targets only Example', async () => {
  let stop: (() => void) | undefined, fail = false
  const methods: string[] = []
  const send: typeof fetch = async (input, init) => {
    const url = String(input)
    if (url.includes('/trace')) return Response.json({ routes: [rawRoute(1)] })
    if (url.includes('/refresh')) {
      assert.ok(url.endsWith('/quotas/refresh?provider=example-provider'))
      methods.push(init?.method || 'GET')
      throw Error('vendor timeout')
    }
    if (fail) throw Error('gateway temporarily unavailable')
    return Response.json({ data: [{ provider: 'codex', windows: [{ name: '7 days', used: 81 }] },
      { provider: 'example-provider', windows: [{ name: '5 hours', used: 2 }, { name: '7 days', used: 48 }] }] })
  }
  const module = { default(orca: OrcaWorkerApi) { stop = activateMonitor(orca, { send:withUsage(send), background: false, conversations: async () => [] }) }, deactivate() { stop?.() } }
  const host = mockHost({ capabilities: ['settings:own', 'storage:own'], settings: { quotaProvider: 'example-provider' } })
  const worker = await mountWorker(module, { host, commands: ['magpie.refresh', 'magpie.sessions'] })
  const first = await worker.request('monitor.get')
  // Explicit quota selection stays independent of the current TPS session.
  await worker.request('monitor.select', { session: first.sessions[0].key })
  fail = true
  const result = await worker.request('monitor.refresh')
  assert.ok(result.quotaError)
  assert.equal(result.cards.find(c => c.provider === 'example-provider')?.windows[0].used, 2)
  const quotaCalls = host.callsOf('statusBar.update').filter(call => JSON.stringify(call).includes('example-provider 5h 余98%'))
  assert.ok(JSON.stringify(quotaCalls[quotaCalls.length - 1]).includes('待更新'))
  assert.deepEqual(methods, ['POST'])
  assert.deepEqual(worker.refusals, [])
  await worker.deactivate()
})
test('worker reports transport failures without claiming zero usage or zero speed', async () => {
  let stop: (() => void) | undefined
  const module = { default(orca: OrcaWorkerApi) { stop = activateMonitor(orca, { send: async () => { throw Error('network') }, background: false, conversations: async () => [] }) }, deactivate() { stop?.() } }
  const worker = await mountWorker(module, { host: mockHost({ capabilities: ['settings:own', 'storage:own'] }), commands: ['magpie.refresh', 'magpie.sessions'] })
  const result = await worker.request('monitor.get')
  assert.ok(result.quotaError && result.speedError)
  assert.equal(result.cards.length, 0)
  assert.equal(result.sessions.length, 0)
  await worker.deactivate()
})
test('status bar shows only the current mean while the popup still opens all sessions', async () => {
  let stop: (() => void) | undefined, at = instant, tick = 0, shown: unknown
  const speeds = [10,40,100,200]
  const send: typeof fetch = async input => Response.json(String(input).includes('/trace') ? {
    routes: speeds.map((v,i) => rawRoute(i+1,`chat-${i}`,{provider:'example-provider',done:false,estTok:10+tick*v}))
  } : {data:[{provider:'example-provider',windows:[{name:'5 hours',used:60,resetsAt:'2026-11-13T21:00:00Z'},{name:'7 days',used:85,resetsAt:'2026-11-15T03:00:00Z'}]}]})
  const module = {default(orca:OrcaWorkerApi) {stop=activateMonitor(orca,{send:withUsage(send),clock:()=>at,background:false,
    conversations:async()=>[],focus:async()=>({orcaSession:'current',session:'chat-3',workspace:'ws',title:'当前'}),popup:{update(){},async show(data){shown=popupData(data)},close(){}}})},deactivate(){stop?.()}}
  const host=mockHost({capabilities:['settings:own','storage:own']})
  const worker=await mountWorker(module,{host,commands:['magpie.refresh','magpie.sessions']})
  await worker.request('monitor.get'); tick=1;at+=1000
  await worker.request('monitor.refresh');await worker.request('monitor.get')
  const calls=host.callsOf('statusBar.update').map(v=>JSON.stringify(v))
  assert.ok(calls.some(s=>s.includes('200T/s')&&s.includes('accent')))
  assert.ok(calls.some(s=>s.includes('"id":"speed2"')&&s.includes('"visible":false')))
  assert.ok(calls.some(s=>s.includes('"id":"speed3"')&&s.includes('"visible":false')))
  assert.ok(calls.some(s=>s.includes('余40%')&&s.includes('warning')&&s.includes('重置')))
  assert.ok(calls.some(s=>s.includes('余15%')&&s.includes('danger')))
  await worker.command('magpie.sessions')
  assert.equal((shown as ReturnType<typeof popupData>).sessions.length,4)
  assert.equal((shown as ReturnType<typeof popupData>).sessions[0].speed,'200T/s')
  assert.deepEqual(worker.refusals,[])
  await worker.deactivate()
})
test('following the current cchost session switches both the status bar and refresh target', async () => {
  let stop: (() => void) | undefined
  let session = 'gemini'
  const model = 'claude-sonnet-5-5', posts: string[] = [], sources = ['claude', 'gemini']
  const cards = sources.map((s, i) => ({ provider: s + '-cchost', windows: [{ name: '5 hours', used: 20 + i * 50 }] }))
  const send: typeof fetch = async (input, init) => {
    const url = new URL(String(input))
    if (url.pathname.endsWith('/trace')) return Response.json({
      routes: sources.map((s, i) => rawRoute(i + 1, s, { model, provider: s + '-cchost' })),
    })
    if (init?.method === 'POST') {
      const provider = url.searchParams.get('provider') || ''
      posts.push(provider)
      return Response.json({ data: cards.filter(c => c.provider === provider) })
    }
    return Response.json({ data: cards })
  }
  const module = { default(orca: OrcaWorkerApi) {
    stop = activateMonitor(orca, { send: withUsage(send), background: false, conversations: async () => [],
      focus: async () => ({ session, orcaSession: session, workspace: '', title: session, model }) })
  }, deactivate() { stop?.() } }
  const host = mockHost({ capabilities: ['settings:own', 'storage:own'] })
  const worker = await mountWorker(module, { host, commands: ['magpie.refresh', 'magpie.sessions'] })
  try {
    const gemini = await worker.request('monitor.refresh')
    assert.equal(popupData(gemini).quotas[0]?.value, '剩余 30%')
    session = 'claude'
    const claude = await worker.request('monitor.refresh')
    assert.equal(popupData(claude).quotas[0]?.value, '剩余 80%')
    assert.deepEqual(posts, ['gemini-cchost', 'claude-cchost'])
    const updates = host.callsOf('statusBar.update').map(x => JSON.stringify(x))
    assert.ok(updates.some(x => x.includes('cchost · Gemini 5h 余30%')))
    assert.ok(updates.some(x => x.includes('cchost · Claude 5h 余80%')))
  } finally { await worker.deactivate() }
})

test('a full-page view without a status bar cannot stop metric delivery', async () => {
  let stop:(()=>void)|undefined
  const send:typeof fetch=async input=>Response.json(String(input).includes('/trace') ? {routes:[rawRoute(1)]}
    : {data:[{provider:'example-provider',windows:[{name:'5 hours',used:2}]}]})
  const module={default(orca:OrcaWorkerApi){stop=activateMonitor(orca,{send:withUsage(send),background:false,conversations:async()=>[]})},deactivate(){stop?.()}}
  const host=mockHost({capabilities:['settings:own','storage:own'],results:{'statusBar.update':()=>{throw hostError('unavailable','No status bar in full-page view')}}})
  const worker=await mountWorker(module,{host,commands:['magpie.refresh','magpie.sessions']})
  const first=await worker.request('monitor.get')
  assert.equal(first.sessions.length,1);assert.equal(first.speedError,null)
  assert.ok(worker.posts.some(p=>p.event==='monitor.changed'))
  await worker.request('monitor.refresh')
  assert.equal(worker.logs.length,5)
  await worker.deactivate()
})

test('current tab binds an idle conversation, follows switches and never substitutes a faster chat', async () => {
  let stop: (() => void) | undefined, failure = false
  let focus: FocusedConversation | null = { orcaSession:'orca-0',session:'chat-0',workspace:'workspace',title:'当前空闲对话' }
  const send: typeof fetch = async input => Response.json(String(input).includes('/trace')
    ? {routes:[rawRoute(1,'chat-0'),rawRoute(2,'chat-3',{done:false,estTok:100})]}
    : {data:[{provider:'example-provider',windows:[{name:'5 hours',used:10}]}]})
  const module = { default(orca: OrcaWorkerApi) { stop = activateMonitor(orca, {
    send:withUsage(send),background:false,conversations:async()=>[],
    focus:async()=>{if(failure)throw Error('focus unavailable');return focus},
  }) },deactivate(){stop?.()} }
  const host=mockHost({capabilities:['storage:own','settings:own']})
  const worker=await mountWorker(module,{host,commands:['magpie.refresh','magpie.sessions']})
  const latest=(id:string)=>host.callsOf('statusBar.update').map(c=>JSON.stringify(c)).filter(p=>p.includes(`"id":"${id}"`)).at(-1)!
  await worker.request('monitor.refresh')
  assert.equal((await worker.request('monitor.get')).focusedConversation?.orcaSession,'orca-0')
  assert.ok(latest('speed').includes('"text":"10T/s'))
  assert.ok(latest('speed2').includes('"visible":false'))
  assert.ok(latest('speed').includes('自动关联当前标签页'))
  focus={...focus!,orcaSession:'orca-3',session:'chat-3'}
  await worker.request('monitor.refresh')
  assert.ok(latest('speed').includes('"text":"200T/s'))
  focus={...focus,session:'not-observed'}
  await worker.request('monitor.refresh')
  assert.ok(latest('speed').includes('—T/s · 当前对话暂无测速数据'))
  focus={...focus,session:''}
  await worker.request('monitor.refresh')
  assert.ok(latest('speed').includes('—T/s · 当前对话等待会话信息'))
  failure=true
  await worker.request('monitor.refresh')
  const data=await worker.request('monitor.get')
  assert.equal(data.focusedConversation,null)
  assert.ok(data.focusError)
  assert.ok(latest('speed').includes('—T/s · 等待当前会话'))
  failure=false;focus=null
  await worker.request('monitor.refresh')
  assert.equal((await worker.request('monitor.get')).focusError,null)
  assert.deepEqual(worker.refusals,[])
  await worker.deactivate()
})

test('an identified native conversation without Magpie records shows its agent and an unavailable speed', async () => {
  let stop: (() => void) | undefined
  const focus: FocusedConversation = { orcaSession: 'native-orca', session: 'native-antigravity', workspace: 'workspace',
    title: '会话示例', agent: 'antigravity', model: 'gemini-4-neon', effort: 'high' }
  const send: typeof fetch = async input => Response.json(String(input).includes('/trace')
    ? { routes: [] } : { total: 0, rows: [] })
  const module = { default(orca: OrcaWorkerApi) {
    stop = activateMonitor(orca, { send, background: false, conversations: async () => [], focus: async () => focus })
  }, deactivate() { stop?.() } }
  const host = mockHost({ capabilities: ['storage:own', 'settings:own'], settings: { showQuota: false } })
  const worker = await mountWorker(module, { host, commands: ['magpie.refresh', 'magpie.sessions'] })
  await worker.request('monitor.refresh')
  const state = await worker.request('monitor.get')
  assert.deepEqual(state.focusedConversation, focus)
  const bar = host.callsOf('statusBar.update').filter(c => (c as { id: string }).id === 'speed').at(-1) as { text: string; tooltip: string; tone: string }
  assert.equal(bar.text, '—T/s · 当前对话暂无测速数据')
  assert.ok(bar.tooltip.includes('Antigravity / gemini-4-neon / high'))
  assert.equal(bar.tone, 'neutral')
  assert.equal(state.sessions.length, 0)
  assert.deepEqual(worker.refusals, [])
  await worker.deactivate()
})

test('native Antigravity counters refresh without Magpie requests or an available gateway', async () => {
  let stop: (() => void) | undefined, reads = 0
  const focus: FocusedConversation = { orcaSession: 'native-orca', session: 'native-antigravity', workspace: 'workspace',
    title: '原生会话', agent: 'antigravity', model: 'gemini-4-neon' }
  const seed = sampleSnapshot().sessions[0]
  const native = async () => ({ ...seed, key: 'native-test', agent: 'antigravity', session: focus.session,
    statsSource: 'antigravity-native', model: focus.model!, averageTPS: ++reads * 50,
    conversation: { ...focus, prompt: '', updatedAt: instant, running: true } })
  const module = { default(orca: OrcaWorkerApi) {
    stop = activateMonitor(orca, { send: async () => { throw Error('gateway offline') }, background: false,
      conversations: async () => [], focus: async () => focus, native })
  }, deactivate() { stop?.() } }
  const host = mockHost({ capabilities: ['storage:own', 'settings:own'], settings: { showQuota: false } })
  const worker = await mountWorker(module, { host, commands: ['magpie.refresh', 'magpie.sessions'] })
  await worker.request('monitor.refresh')
  const first = await worker.request('monitor.get')
  assert.ok(first.sessions[0].averageTPS! > 0)
  const before = reads
  await worker.request('monitor.refresh')
  const second = await worker.request('monitor.get')
  assert.ok(reads > before)
  assert.equal(second.sessions[0].statsSource, 'antigravity-native')
  const bar = host.callsOf('statusBar.update').filter(c => (c as { id: string }).id === 'speed').at(-1) as { text: string; tooltip: string; tone: string }
  assert.ok(bar.text.includes('原生请求均速'))
  assert.ok(bar.tooltip.includes('含首字等待'))
  assert.equal(bar.text.includes('暂无测速数据'), false)
  assert.deepEqual(worker.refusals, [])
  await worker.deactivate()
})

test('switching to native Antigravity does not wait for another sessions pending gateway summary', async () => {
  let stop: (() => void) | undefined
  let focus: FocusedConversation = { orcaSession: 'gateway-orca', session: 'gateway-thread', workspace: 'workspace', title: '网关会话', agent: 'codex' }
  let resolveUsage: ((r: Response) => void) | undefined
  let nativeReads = 0
  const seed = sampleSnapshot().sessions[0]
  const send: typeof fetch = async input => {
    if (String(input).includes('/trace')) return Response.json({ routes: [rawRoute(1, 'gateway-thread')] })
    return new Promise<Response>(resolve => { resolveUsage = resolve })
  }
  const module = { default(orca: OrcaWorkerApi) { stop = activateMonitor(orca, {
    send, background: false, conversations: async () => [], focus: async () => focus,
    native: async current => {
      nativeReads++
      return { ...seed, key: 'native-focused', session: current.session, agent: 'antigravity',
        requestedModel: current.model, model: current.model!, averageTPS: 67.4, statsSource: 'antigravity-native',
        conversation: { ...current, prompt: '', updatedAt: instant } }
    },
  }) }, deactivate() { stop?.() } }
  const host = mockHost({ capabilities: ['settings:own', 'storage:own'], settings: { showQuota: false, ignoredQuotaModels: 'gemini' } })
  const worker = await mountWorker(module, { host, commands: ['magpie.refresh', 'magpie.sessions'] })
  await worker.request('monitor.get')
  for (let i = 0; !resolveUsage && i < 100; i++) await new Promise(resolve => setTimeout(resolve, 1))
  assert.ok(resolveUsage)
  focus = { orcaSession: 'native-orca', session: 'native-thread', workspace: 'workspace', title: '原生会话', agent: 'antigravity', model: 'gemini-4-neon' }
  const switched = worker.request('monitor.refresh')
  for (let i = 0; !nativeReads && i < 50; i++) await new Promise(resolve => setTimeout(resolve, 1))
  const readsBeforeGatewayCompleted = nativeReads
  resolveUsage!(Response.json({ total: 0, rows: [] }))
  const result = await switched
  await worker.deactivate()
  assert.ok(readsBeforeGatewayCompleted > 0, 'native counters must be read before the gateway summary completes')
  assert.ok(result.sessions.some(s => s.session === 'native-thread' && s.averageTPS === 67.4))
})

test('complete status bar labels fit the host limit with native metrics, emoji titles and source labels', async () => {
  let stop: (() => void) | undefined
  const seed = sampleSnapshot().sessions[0]
  let source = 'antigravity'
  const focus = { orcaSession: 'native-orca', session: 'native-thread', workspace: 'workspace', title: '🧪'.repeat(30), agent: 'antigravity', model: 'gemini-4-neon' }
  const module = { default(orca: OrcaWorkerApi) { stop = activateMonitor(orca, {
    send: withUsage(async input => Response.json(String(input).includes('/trace') ? { routes: [] } : { data: [] })),
    background: false, conversations: async () => [], focus: async () => focus,
    native: async () => ({ ...seed, key: 'native-focused', session: focus.session, agent: 'antigravity', requestedModel: focus.model,
      model: focus.model, provider: source, statsSource: 'antigravity-native', averageTPS: 167.4, totalTokens: 21946042, cacheHitRate: .942,
      conversation: { ...focus, prompt: '', updatedAt: instant } }),
  }) }, deactivate() { stop?.() } }
  const host = mockHost({ capabilities: ['settings:own', 'storage:own'], settings: { showQuota: false }, results: {
    'statusBar.update': (value: unknown) => {
      if ((value as { text: string }).text.length > 64) throw hostError('invalid_params', 'status text exceeds 64 characters')
      return null
    },
  } })
  const worker = await mountWorker(module, { host, commands: ['magpie.refresh', 'magpie.sessions'] })
  await worker.request('monitor.refresh')
  source = 'gemini-cchost'
  await worker.request('monitor.refresh')
  const updates = host.callsOf('statusBar.update') as { id: string; text: string }[]
  await worker.deactivate()
  assert.ok(updates.every(s => s.text.length <= 64))
  assert.ok(updates.some(s => s.id === 'speed' && s.text.includes('167.4T/s') && s.text.includes('Token 21.9M') && s.text.includes('94.2%')))
  assert.equal(worker.logs.some(line => String(line).includes('invalid_params')), false)
})

test('an older selected conversation can load its summary even after leaving the trace window', async () => {
  let stop:(()=>void)|undefined
  const send:typeof fetch=async input=>{
    const url=String(input)
    if(url.includes('/usage/requests')){
      const q=new URL(url).searchParams
      if(q.get('q')==='older')return Response.json({total:2,decode_out:400,decode_ms:10000,decode_n:2,
        input:100,output:200,cache_read:900,cache_write:0,
        rows:[{agent:'orca_desktop',session:'older',model:'gpt-6.1-sol',req:'Seed/gpt-6.1-sol',t:instant?new Date(instant).toISOString():''}]})
      return Response.json({total:0,rows:[]})
    }
    return Response.json(url.includes('/trace')?{routes:[rawRoute(1,'newer')]}:{data:[{provider:'example-provider',windows:[]}]})
  }
  const module={default(orca:OrcaWorkerApi){stop=activateMonitor(orca,{send,background:false,conversations:async()=>[],
    focus:async()=>({orcaSession:'orca-older',session:'older',workspace:'ws',title:'较早的当前对话'})})},deactivate(){stop?.()}}
  const host=mockHost({capabilities:['storage:own','settings:own']})
  const worker=await mountWorker(module,{host,commands:['magpie.refresh','magpie.sessions']})
  await worker.request('monitor.refresh');await worker.request('monitor.refresh')
  const data=await worker.request('monitor.get'),s=data.sessions.find(s=>s.session==='older')!
  assert.ok(s);assert.equal(s.averageTPS,40);assert.equal(s.totalTokens,1200);assert.equal(s.cacheHitRate,.9)
  assert.equal(s.requestedModel,'Seed/gpt-6.1-sol')
  assert.ok(host.callsOf('statusBar.update').some(c=>{const text=JSON.stringify(c);return text.includes('40T/s')&&text.includes('[Seed]')&&text.includes('[Token 1.2K][缓存 90%]')}))
  assert.deepEqual(worker.refusals,[])
  await worker.deactivate()
})
test('many sessions keep only one summary per session and at most two summary requests in flight',async()=>{
 let stop:(()=>void)|undefined,active=0,max=0,reads=0
 const send:typeof fetch=async input=>{
  const url=String(input)
  if(url.includes('/usage/requests')){
   active++;reads++;max=Math.max(max,active)
   await new Promise(resolve=>setTimeout(resolve,2));active--
   const q=new URL(url).searchParams
   return Response.json({total:1,decode_out:100,decode_ms:1000,decode_n:1,rows:[{agent:q.get('agent'),session:q.get('q'),t:new Date(instant).toISOString()}]})
  }
  return Response.json(url.includes('/trace')?{routes:Array.from({length:200},(_,i)=>rawRoute(i,'session-'+i))}:{data:[{provider:'example-provider',windows:[]}]})
 }
 const module={default(orca:OrcaWorkerApi){stop=activateMonitor(orca,{send,background:false,conversations:async()=>[]})},deactivate(){stop?.()}}
 const worker=await mountWorker(module,{host:mockHost({capabilities:['settings:own','storage:own']}),commands:['magpie.refresh','magpie.sessions']})
 await worker.request('monitor.get');const snapshot=await worker.request('monitor.refresh')
 assert.equal(snapshot.sessions.length,100);assert.equal(snapshot.omittedSessions,100)
 assert.equal(max,2);assert.equal(reads,100)
 assert.ok(snapshot.sessions.every(s=>s.averageTPS===100&&s.statsSource==='magpie'))
 await worker.deactivate()
})

test('quota switch stops all quota requests, hides both bars and keeps session metrics', async () => {
  const requested: string[] = []
  let stop: (() => void) | undefined
  const send: typeof fetch = async input => {
    const url = String(input); requested.push(url)
    return Response.json(url.includes('/trace') ? { routes: [rawRoute(1)] }
      : { data: [{ provider: 'example-provider', windows: [{ name: '5 hours', used: 8 }] }] })
  }
  const module = { default(orca: OrcaWorkerApi) { stop = activateMonitor(orca, { send: withUsage(send), background: false, conversations: async () => [] }) }, deactivate() { stop?.() } }
  const host = mockHost({ capabilities: ['settings:own', 'storage:own'], settings: { showQuota: false } })
  const worker = await mountWorker(module, { host, commands: ['magpie.refresh', 'magpie.sessions'] })
  await worker.request('monitor.get')
  const first = await worker.request('monitor.refresh')
  assert.equal(first.showQuota, false); assert.equal(first.quotaError, null)
  assert.equal(first.sessions[0].averageTPS, 100)
  assert.equal(requested.some(url => url.includes('/quotas')), false)
  for (const id of ['quota5h', 'quota7d']) assert.ok(host.callsOf('statusBar.update').some(c => {
    const item = c as { id: string; visible: boolean }; return item.id === id && !item.visible
  }))
  assert.deepEqual(popupData(first).quotas, [])
  const enabled = await worker.request('monitor.quota', { enabled: true })
  assert.equal(enabled.showQuota, true); assert.equal(host.data().settings.showQuota, true)
  assert.ok(requested.some(url => url.includes('/quotas/refresh?provider=example-provider')))
  const disabled = await worker.request('monitor.quota', { enabled: false })
  assert.equal(host.data().settings.showQuota, false); assert.equal(disabled.cards.length, 0)
  requested.length = 0
  await worker.request('monitor.refresh')
  assert.equal(requested.some(url => url.includes('/quotas')), false)
  assert.deepEqual(worker.refusals, [])
  await worker.deactivate()
})

test('switching sources refreshes only that provider and supports balance-only cards', async () => {
  const posts: string[] = []
  let stop: (() => void) | undefined
  const cards = [
    { provider: 'example-provider', windows: [{ name: '5 hours', used: 8 }] },
    { provider: 'wallet/source', name: 'Wallet', balance: '$12.34', windows: [] },
  ]
  const send: typeof fetch = async (input, init) => {
    const url = String(input)
    if (url.includes('/trace')) return Response.json({ routes: [rawRoute(1)] })
    if (init?.method === 'POST') { posts.push(url); return Response.json({ data: [cards[1]] }) }
    return Response.json({ data: cards })
  }
  const module = { default(orca: OrcaWorkerApi) { stop = activateMonitor(orca, { send: withUsage(send), background: false, conversations: async () => [] }) }, deactivate() { stop?.() } }
  const host = mockHost({ capabilities: ['settings:own', 'storage:own'] })
  const worker = await mountWorker(module, { host, commands: ['magpie.refresh', 'magpie.sessions'] })
  await worker.request('monitor.get')
  const data = await worker.request('monitor.quota', { provider: 'wallet/source' })
  assert.equal(host.data().settings.quotaProvider, 'wallet/source')
  assert.equal(data.quotaError, null); assert.equal(data.cards.length, 2)
  assert.deepEqual(posts, ['http://127.0.0.1:3425/v1/magpie/quotas/refresh?provider=wallet%2Fsource'])
  assert.equal(popupData(data).quotas[0].value, '$12.34')
  assert.ok(host.callsOf('statusBar.update').some(c => JSON.stringify(c).includes('Wallet 余额 $12.34')))
  assert.deepEqual(worker.refusals, [])
  await worker.deactivate()
})

test('a late quota response cannot restore cards after the switch is turned off', async () => {
  let stop: (() => void) | undefined, resolveQuota: ((r: Response) => void) | undefined
  const send: typeof fetch = async input => String(input).includes('/trace') ? Response.json({ routes: [] })
    : new Promise<Response>(resolve => { resolveQuota = resolve })
  const module = { default(orca: OrcaWorkerApi) { stop = activateMonitor(orca, { send, background: false, conversations: async () => [] }) }, deactivate() { stop?.() } }
  const worker = await mountWorker(module, { host: mockHost({ capabilities: ['settings:own', 'storage:own'] }), commands: ['magpie.refresh', 'magpie.sessions'] })
  const initial = worker.request('monitor.get')
  while (!resolveQuota) await new Promise(resolve => setTimeout(resolve, 0))
  await worker.request('monitor.quota', { enabled: false })
  resolveQuota!(Response.json({ data: [{ provider: 'example-provider', windows: [{ name: '5 hours', used: 99 }] }] }))
  await initial
  const data = await worker.request('monitor.get')
  assert.equal(data.showQuota, false); assert.equal(data.quotaError, null); assert.deepEqual(data.cards, [])
  await worker.deactivate()
})

test('switching source ignores a late response for the previous source', async () => {
  let stop: (() => void) | undefined, resolveOld: ((r: Response) => void) | undefined, reads = 0
  const cards = [{ provider: 'example-provider', windows: [{ name: '5 hours', used: 8 }] },
    { provider: 'deepseek', name: 'DeepSeek', balance: '¥42.00', windows: [] }]
  const send: typeof fetch = async (input, init) => {
    const url = String(input)
    if (url.includes('/trace')) return Response.json({ routes: [] })
    if (init?.method === 'POST') return Response.json({ data: [cards[1]] })
    if (++reads === 1) return new Promise<Response>(resolve => { resolveOld = resolve })
    return Response.json({ data: cards })
  }
  const module = { default(orca: OrcaWorkerApi) { stop = activateMonitor(orca, { send, background: false, conversations: async () => [] }) }, deactivate() { stop?.() } }
  const worker = await mountWorker(module, { host: mockHost({ capabilities: ['settings:own', 'storage:own'] }), commands: ['magpie.refresh', 'magpie.sessions'] })
  const initial = worker.request('monitor.get')
  while (!resolveOld) await new Promise(resolve => setTimeout(resolve, 0))
  await worker.request('monitor.quota', { provider: 'deepseek' })
  resolveOld!(Response.json({ data: [{ provider: 'example-provider', windows: [{ name: '5 hours', used: 99 }] }] }))
  await initial
  const data = await worker.request('monitor.get')
  assert.equal(data.quotaProvider, 'deepseek'); assert.equal(data.quotaError, null)
  assert.equal(popupData(data).quotas[0].value, '¥42.00')
  assert.deepEqual(data.cards.find(c => c.provider === 'example-provider')!.windows, [])
  await worker.deactivate()
})

test('status bar displays account means and popup retains the individual readings', async () => {
  let stop: (() => void) | undefined
  const send: typeof fetch = async input => Response.json(String(input).includes('/trace') ? { routes: [] } : { data: [
    { provider: 'example-provider', windows: [{ name: '5 hours', used: 80 }, { name: '7 days', used: 20 }] },
    { provider: 'example-provider', windows: [{ name: '5 hours', used: 40 }, { name: '7 days', used: 60 }] },
  ] })
  const module = { default(orca: OrcaWorkerApi) { stop = activateMonitor(orca, { send, background: false, conversations: async () => [] }) }, deactivate() { stop?.() } }
  const host = mockHost({ capabilities: ['settings:own', 'storage:own'] })
  const worker = await mountWorker(module, { host, commands: ['magpie.refresh', 'magpie.sessions'] })
  const state = await worker.request('monitor.get')
  const calls = host.callsOf('statusBar.update').map(c => JSON.stringify(c))
  assert.ok(calls.some(c => c.includes('example-provider 5h 均值 余40%')))
  assert.ok(calls.some(c => c.includes('7d 均值 余60%')))
  const popup = popupData(state)
  assert.equal(popup.quotas[0].value, '剩余 40%')
  assert.equal(popup.quotas.length, 6)
  assert.deepEqual(state.cards.map(c => c.windows[0].remaining), [20, 60])
  await worker.deactivate()
})

test('the current parent keeps its mean when Claude children share its session ID', async () => {
  let stop: (() => void) | undefined
  const send: typeof fetch = async input => Response.json(String(input).includes('/trace') ? { routes: [
    rawRoute(1, 'shared-thread', { agent: 'claude' }),
    rawRoute(2, 'shared-thread', { agent: 'claude', subagentId: 'worker-1' }),
  ] } : { data: [{ provider: 'example-provider', windows: [] }] })
  const module = { default(orca: OrcaWorkerApi) { stop = activateMonitor(orca, {
    send: withUsage(send), background: false, conversations: async () => [],
    focus: async () => ({ orcaSession: 'parent', session: 'shared-thread', workspace: 'workspace', title: '当前主会话' }),
  }) }, deactivate() { stop?.() } }
  const host = mockHost({ capabilities: ['settings:own', 'storage:own'] })
  const worker = await mountWorker(module, { host, commands: ['magpie.refresh', 'magpie.sessions'] })
  const state = await worker.request('monitor.refresh')
  assert.equal(state.sessions.find(s => !s.subagent)!.averageTPS, 100)
  assert.equal(state.sessions.find(s => s.subagent)!.averageTPS, null)
  const speed = host.callsOf('statusBar.update').map(c => c as { id: string; text: string }).filter(c => c.id === 'speed').at(-1)!
  assert.ok(speed.text.startsWith('100T/s'))
  assert.deepEqual(worker.refusals, [])
  await worker.deactivate()
})
