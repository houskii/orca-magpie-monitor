import { assert, test } from 'orca/testing'
import { SessionMeter } from './metrics'
import { cchostSnapshot, instant, rawRoute, sampleSnapshot } from './fixtures'
import { cachePercent, compactTokens, currentQuota, duration, isRunning, liveRate, meanLabel, quotaTone, rate, running, speedNote, speedTone, speedValue } from './presentation'
import { panelSnapshot } from './bounds'
import { popupData } from './popup'
import { parseCards } from './metrics'

test('speed and remaining-quota colors include the requested boundary values', () => {
  assert.deepEqual([0,19.9,20,49.9,50,150,150.1].map(speedTone), ['danger','danger','warning','warning','success','success','accent'])
  assert.deepEqual([null,0,20,20.1,50,50.1,100].map(quotaTone), ['neutral','danger','danger','warning','warning','success','success'])
  assert.equal(rate(null), '—T/s'); assert.equal(rate(undefined), '—T/s'); assert.equal(rate(0), '0T/s')
  assert.equal(duration(11288000),'03h:08m:08s');assert.equal(duration(202000),'03m:22s');assert.equal(duration(null),'—')
  assert.equal(compactTokens(67539963),'67.5M');assert.equal(cachePercent(.988),'98.8%')
})
test('running cards rank at most three by output mean; idle history cannot outrank them', () => {
  const rows = sampleSnapshot().sessions
  const sessions = [10,200,100,40].map((speed,i) => ({ ...rows[0], key: String(i), active: 1, runningTPS: speed, averageTPS: speed }))
  sessions.push({ ...rows[1], key: 'idle', active: 0, runningTPS: 9999, averageTPS: 9999 })
  assert.deepEqual(running(sessions).map(s => s.runningTPS), [200,100,40])

})
test('live sampling does not invent a session mean without Magpie statistics', () => {
  const meter = new SessionMeter()
  let s
  for (let i=0;i<=5;i++) s = meter.ingest({ routes: [rawRoute(1,'live',{ done:false,estTok:i<5 ? 10+i*100 : 420 })] },instant+i*1000)[0]
  assert.equal(s!.runningTPS,null)
  assert.equal(s!.liveTPS,70)
  const data = sampleSnapshot(); data.sessions = [s!]
  const popup = popupData(data)
  assert.equal(popup.sessions[0].speed,'—T/s')
  assert.equal(popup.sessions[0].live,'70T/s')
})

test('tool execution keeps the conversation mean while real-time output is zero', () => {
  const s = new SessionMeter().ingest({ routes: [rawRoute(1)] }, instant)[0]
  Object.assign(s,{averageTPS:100,measuredOutput:200,generationMs:2000,statsSource:'magpie'})
  s.conversation = { session:s.session,orcaSession:'orca',title:'正在执行工具',prompt:'检查项目',updatedAt:instant,running:true }
  assert.equal(s.active,0)
  assert.equal(isRunning(s),true)
  assert.equal(speedValue(s),100)
  assert.equal(running([s]).length,1)
  const data=sampleSnapshot();data.sessions=[s]
  assert.equal(popupData(data).sessions[0].speed,'100T/s')
  assert.equal(popupData(data).sessions[0].live,'0T/s')
})

test('native request means are labeled separately and do not invent live TPS', () => {
  const data = sampleSnapshot(), session = data.sessions[0]
  session.statsSource = 'antigravity-native'
  session.model = 'gemini-4-neon'
  session.averageTPS = 52.3
  assert.equal(meanLabel(session), '原生请求均速')
  assert.equal(liveRate(session), '—T/s')
  assert.ok(speedNote(session).includes('含首字等待'))
  const row = popupData(data).sessions.find(s => s.model === 'gemini-4-neon')!
  assert.equal(row.speed, '52.3T/s')
  assert.equal(row.speedLabel, '原生请求均速')
  assert.equal(row.startedLabel, '原生首个请求')
  assert.equal(row.live, '—T/s')
})

test('popup shows the selected source and all its accounts without invented 5h or 7d windows', () => {
  const data = sampleSnapshot()
  data.quotaProvider = 'credits'
  data.cards.push(...parseCards({ data: [
    { provider: 'credits', name: 'Credits', windows: [{ name: 'Monthly credits', used: 20 }] },
    { provider: 'credits', name: 'Credits', balance: '$42', windows: [] },
  ] }))
  const popup = popupData(data)
  assert.equal(popup.quotas.length, 3)
  assert.deepEqual(popup.quotas.map(q => q.value), ['剩余 80%', '剩余 80%', '$42'])
  assert.ok(popup.quotas[0].name.includes('均值'))
  assert.equal(popup.quotas[0].detail, '1/2 个账号参与平均')
  assert.ok(popup.quotas.every(q => !q.name.includes('Example') && !q.name.includes('5h') && !q.name.includes('7d')))
  data.showQuota = false; data.quotaError = 'old failure'
  assert.deepEqual(popupData(data).quotas, [])
  assert.equal(popupData(data).quotaError, null)
  assert.equal(popupData(data).sessions.length, data.sessions.length)
})

test('the same Claude model uses the focused account source and its own reset time', () => {
  const state = cchostSnapshot('gemini')
  const snapshot = panelSnapshot(state)
  assert.equal(currentQuota(snapshot).provider, 'gemini-cchost')
  assert.equal(currentQuota(snapshot).card?.windows[0].resetsAt, '2026-11-13T14:00:00Z')
  assert.deepEqual(popupData(snapshot).quotas.map(q => q.value), ['剩余 87.9%', '剩余 95%'])
  assert.ok(popupData(snapshot).quotas.every(q => q.name.startsWith('cchost · Gemini') && q.brand === 'cchost'))
  state.focusedConversation!.session = 'claude'
  assert.equal(currentQuota(state).provider, 'claude-cchost')
  assert.equal(popupData(state).quotas[0].value, '剩余 66%')
  state.focusedConversation!.session = 'unseen'
  assert.equal(currentQuota(state).provider, '')
  assert.deepEqual(popupData(state).quotas, [])
  state.quotaProvider = 'gemini-cchost'
  assert.equal(currentQuota(state).provider, 'gemini-cchost')
})

test('ignored model families hide quotas and errors even for a manually selected source', () => {
  const state = cchostSnapshot('gemini')
  state.ignoredQuotaModels = ['gpt', 'gemini*']
  // The gateway source is named Gemini, but the actual response model is Claude.
  state.focusedConversation!.model = 'gemini-4-pro'
  assert.equal(currentQuota(state).ignored, false)
  const session = state.sessions.find(s => s.session === 'gemini')!
  session.model = 'gateway/GPT-6-sol'
  session.averageTPS = 42
  state.quotaProvider = 'claude-cchost'
  state.quotaError = 'old quota failure'
  const binding = currentQuota(state)
  assert.equal(binding.ignored, true)
  assert.equal(binding.provider, '')
  assert.equal(binding.error, null)
  const snapshot = panelSnapshot(state), popup = popupData(snapshot)
  assert.deepEqual(snapshot.cards, [])
  assert.equal(snapshot.quotaError, null)
  assert.deepEqual(popup.quotas, [])
  assert.equal(popup.quotaError, null)
  assert.ok(popup.sessions.some(s => s.model === session.model && s.speed === '42T/s'))
  state.sessions = []
  state.focusedConversation!.model = 'gemini-4-pro'
  assert.equal(currentQuota(state).ignored, true)
  state.focusedConversation!.model = 'claude-opus'
  assert.equal(currentQuota(state).ignored, false)
})
