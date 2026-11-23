import { assert, test } from 'orca/testing'
import { quotaSelection, gatewayBaseURL, parseCards, parseRoutes, selectedSession, SessionMeter } from './metrics'
import { instant, rawRoute } from './fixtures'

test('two simultaneous chats using one model have distinct live TPS', () => {
  const meter = new SessionMeter()
  const live = (a: number, b: number, at: number) => ({ pid: 10, routes: [
    rawRoute(1, 'chat-a', { done: false, estTok: a, contentAt: at }),
    rawRoute(2, 'chat-b', { done: false, estTok: b, contentAt: at }),
  ] })
  let rows = meter.ingest(live(10, 50, instant), instant)
  assert.equal(rows[0].liveTPS, null)
  rows = meter.ingest(live(110, 75, instant + 1000), instant + 1000)
  assert.equal(rows.find(s => s.session === 'chat-a')?.liveTPS, 100)
  assert.equal(rows.find(s => s.session === 'chat-b')?.liveTPS, 25)
  assert.equal(rows.length, 2)
})
test('same session parallel requests sum current throughput; subagents stay separate', () => {
  const meter = new SessionMeter()
  const payload = (n: number) => ({ routes: [rawRoute(1, 'chat-a', { done: false, estTok: n }),
    rawRoute(2, 'chat-a', { done: false, estTok: n * 2 }),
    rawRoute(3, 'chat-a', { done: false, estTok: n * 3, subagentId: 'sub-1' })] })
  meter.ingest(payload(10), instant)
  const rows = meter.ingest(payload(20), instant + 1000)
  assert.equal(rows.find(s => !s.subagent)?.liveTPS, 30)
  assert.equal(rows.find(s => s.subagent)?.liveTPS, 30)
  assert.equal(rows.length, 2)
})
test('missing session IDs do not merge; repeated snapshots do not double-count', () => {
  const meter = new SessionMeter(), payload = { routes: [rawRoute(1, ''), rawRoute(2, '')] }
  meter.ingest(payload, instant)
  const rows = meter.ingest(payload, instant + 1000)
  assert.equal(rows.length, 2)
  assert.equal(rows[0].requests, 1)
})
test('gateway restarts clear data; disappearing active requests and sampling gaps stop stale speeds', () => {
  const meter = new SessionMeter()
  const p = (tokens: number) => ({ pid: 1, routes: [rawRoute(1, 'chat-a', { done: false, estTok: tokens })] })
  meter.ingest(p(10), instant)
  assert.equal(meter.ingest(p(100), instant + 20_000)[0].liveTPS, null)
  assert.equal(meter.ingest({ pid: 1, routes: [] }, instant + 21000).length, 0)
  meter.ingest({ pid: 1, routes: [rawRoute(2)] }, instant)
  assert.equal(meter.ingest({ pid: 2, routes: [] }, instant + 1000).length, 0)
})
test('quota text is not zero percent and separate accounts have distinct selectors', () => {
  const cards = parseCards({ data: [
    { provider: 'x', windows: [{ name: 'Snapshot', text: true, used: 0, display: 'timestamp' }] },
    { provider: 'x', windows: [{ name: 'week', used: 0 }, { name: 'missing' }] },
  ] })
  assert.notEqual(cards[0].key, cards[1].key)
  assert.equal(cards[0].windows[0].used, null)
  assert.equal(cards[1].windows[0].used, 0)
  assert.equal(cards[1].windows[1].used, null)
})
test('gateways accept loopback HTTP and HTTPS with path prefixes; no identity is guessed', () => {
  assert.equal(gatewayBaseURL('http://127.0.0.1:3425/'), 'http://127.0.0.1:3425')
  assert.equal(gatewayBaseURL('http://[::1]:8080'), 'http://[::1]:8080')
  assert.equal(gatewayBaseURL('https://gateway.example.com/monitor/'), 'https://gateway.example.com/monitor')
  for (const url of ['http://example.com', 'ftp://localhost', 'http://127.0.0.1:3425/?key=x', 'http://user@localhost', 'https://example.com/#secret']) assert.throws(() => gatewayBaseURL(url))
  const sessions = new SessionMeter().ingest({ routes: [rawRoute(1), rawRoute(2, 'other', { agent: 'claude', done: false })] }, instant)
  assert.equal(selectedSession(sessions, ''), undefined)
})

test('session records retain the actual answering provider after routing-group fallback', () => {
  const routes = [rawRoute(1, 'codex-chat', { provider: 'group', order: [{ id: 'chosen', provider: 'openai', agent: 'codex', kind: 'account' }], tries: [{ id: 'chosen', model: 'gpt-6.1-sol' }] }),
    rawRoute(2, 'Example-chat', { provider: 'example-provider' })]
  const sessions = new SessionMeter().ingest({ routes }, instant)
  assert.equal(sessions.find(s => s.session === 'codex-chat')?.quotaProvider, 'codex')
  assert.equal(sessions.find(s => s.session === 'Example-chat')?.quotaProvider, 'example-provider')
})
test('auto discovers a gateway quota source and explicit selection is retained', () => {
  const cards = parseCards({ data: [{ provider: 'codex' }, { provider: 'example-provider' }] })
  assert.equal(quotaSelection(cards).card?.provider, 'codex')
  assert.equal(quotaSelection(cards.slice(0, 1)).card?.provider, 'codex')
  assert.equal(quotaSelection(cards, 'example-provider').card?.provider, 'example-provider')
  assert.equal(quotaSelection(cards.slice(0, 1), 'example-provider').card, undefined)
  assert.equal(quotaSelection([]).provider, '')
  const available = parseCards({ data: [
    { provider: 'unavailable', error: 'timeout' },
    { provider: 'no-quota' },
    { provider: 'wallet', name: 'Wallet', balance: '$12' },
  ] })
  assert.equal(quotaSelection(available).provider, 'wallet')
  assert.equal(quotaSelection(available).label, 'Wallet')
})
test('multiple accounts without valid percentage readings have no invented mean', () => {
  const cards = parseCards({ data: [{ provider: 'example-provider', user: 'one' }, { provider: 'example-provider', user: 'two' }] })
  const binding = quotaSelection(cards)
  assert.equal(binding.card, undefined)
  assert.ok(binding.message.includes('2 个账号'))
})

test('account quota means group identical windows and exclude missing or failed readings', () => {
  const cards = parseCards({ data: [
    { provider: 'example-provider', windows: [{ name: '5 hours', used: 100, resetsAt: '2026-11-18T12:00:00Z' }, { name: '7 days', used: 60 }] },
    { provider: 'example-provider', windows: [{ name: '5 hours', used: 0, resetsAt: '2026-11-18T10:00:00Z' }, { name: '7 days', used: 20 }] },
    { provider: 'example-provider', windows: [{ name: '7 days', used: 40 }] },
    { provider: 'example-provider', error: 'timeout', windows: [{ name: '5 hours', used: 0, resetsAt: '2026-11-18T09:00:00Z' }] },
  ] })
  const mean = quotaSelection(cards).card!
  assert.equal(mean.averaged, true)
  assert.deepEqual(mean.windows.map(w => [w.name, w.remaining, w.samples]), [['5 hours', 50, 2], ['7 days', 60, 3]])
  assert.equal(mean.windows[0].display, '2/4 个账号参与平均')
  assert.equal(mean.windows[0].resetsAt, '2026-11-18T10:00:00Z')
  assert.equal(cards[0].windows[0].remaining, 0)
  const fractional = quotaSelection(parseCards({ data: [0, 0, 99].map(used => ({ provider: 'p', windows: [{ name: 'Credits', used }] })) }), 'p').card!
  assert.equal(fractional.windows[0].remaining, 67)
})

test('generic quota cards preserve balances, explicit remaining, unlimited and text readings', () => {
  const card = parseCards({ data: [{ provider: 'other', balance: '$12.34', windows: [
    { name: 'Credits', used: 50, remaining: 25, display: '75 / 100' },
    { name: 'Unlimited', unlimited: true, used: 0, remaining: 100 },
    { name: 'Wallet', balance: 42, unit: 'credits', used: 0, remaining: 0 },
    { name: 'Status', text: true, display: 'Active', used: 0 },
  ] }] })[0]
  assert.equal(card.balance, '$12.34')
  assert.equal(card.windows[0].remaining, 25)
  assert.deepEqual(card.windows.slice(1).map(w => [w.remaining, w.display]), [[null, '不限额'], [null, '42 credits'], [null, 'Active']])
})

test('account means keep distinct model quota pools separate even when window names match', () => {
  const cards = parseCards({ data: [
    { provider: 'antigravity', windows: [{ name: '7 days', pool: 'Gemini', used: 20 }, { name: '7 days', pool: 'Claude', used: 80 }] },
    { provider: 'antigravity', windows: [{ name: '7 days', pool: 'Claude', used: 40 }, { name: '7 days', pool: 'Gemini', used: 40 }] },
  ] })
  const mean = quotaSelection(cards, 'antigravity').card!
  assert.deepEqual(mean.windows.map(w => [w.pool, w.remaining, w.samples]), [['Gemini', 70, 2], ['Claude', 40, 2]])
})

test('new snapshots replace old requests rather than accumulating session history', () => {
 const meter=new SessionMeter()
 for(let i=0;i<10000;i++){
  const rows=meter.ingest({routes:[rawRoute(i,'session-'+i)]},instant+i*1000)
  assert.equal(rows.length,1);assert.equal(rows[0].requests,1)
  assert.equal(rows[0].session,'session-'+i);assert.equal(rows[0].averageTPS,null)
 }
})
