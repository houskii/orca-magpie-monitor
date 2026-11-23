import { assert, mockHost, mount, test } from 'orca/testing'
import * as panel from './panel'
import { sampleSnapshot } from './fixtures'
import { parseCards } from './metrics'
test('sidebar shows every conversation by title and content and opens the popup', async () => {
  const data=sampleSnapshot();let opened=0
  const host=mockHost({requests:{'monitor.get':()=>data,'monitor.refresh':()=>data,'monitor.popup':()=>{opened++;return {opened:true}}}})
  const view=await mount(panel,{host})
  assert.ok(view.find({text:'剩余 52%'}))
  for(const s of data.sessions){assert.ok(view.find({text:s.conversation!.title}));assert.ok(view.find({text:s.conversation!.prompt}))}
  await view.press({text:'打开全部对话弹窗'});assert.equal(opened,1)
  await view.press({text:'刷新'})
  assert.deepEqual(view.errors,[]);assert.deepEqual(view.warnings,[]);assert.deepEqual(view.refusals,[])
  await view.unmount()
})
test('offline state remains visible and never shows stale real-time output', async () => {
  const data={...sampleSnapshot(),speedError:'速度接口离线'}
  const view=await mount(panel,{host:mockHost({requests:{'monitor.get':()=>data}})})
  assert.ok(view.find({text:'速度接口离线'}));assert.ok(view.find({text:'实时 0T/s'}))
  assert.deepEqual(view.errors,[]);await view.unmount()
})
test('native session identity stays visible without a Magpie speed sample', async () => {
  const data = sampleSnapshot()
  data.sessions = []
  data.focusedConversation = { orcaSession: 'orca', session: 'native', workspace: 'workspace', title: '会话示例',
    agent: 'antigravity', model: 'gemini-4-neon', effort: 'high' }
  const view = await mount(panel, { host: mockHost({ requests: { 'monitor.get': () => data } }) })
  assert.ok(view.find({ text: '会话示例' }))
  assert.ok(view.find({ text: 'Antigravity / gemini-4-neon / high' }))
  assert.ok(view.find({ text: '当前对话尚无测速数据，等待请求记录。' }))
  assert.deepEqual(view.errors, [])
  await view.unmount()
})

test('native session cards show native request TPS and its timing definition', async () => {
  const data = sampleSnapshot(), s = data.sessions[0]
  Object.assign(s, { statsSource: 'antigravity-native', agent: 'antigravity', model: 'gemini-4-neon', averageTPS: 52.3 })
  data.focusedConversation = { orcaSession: s.conversation!.orcaSession, session: s.session, workspace: 'workspace',
    title: s.conversation!.title, agent: 'antigravity', model: 'gemini-4-neon' }
  const view = await mount(panel, { host: mockHost({ requests: { 'monitor.get': () => data } }) })
  assert.ok(view.find({ text: '原生请求均速 52.3T/s' }))
  assert.ok(view.find({ text: '已关联 Antigravity 原生测速；每个请求结束后更新均速。' }))
  assert.ok(view.find({ text: '实时 —T/s' }))
  assert.deepEqual(view.errors, []); assert.deepEqual(view.warnings, [])
  await view.unmount()
})
test('panel source and switch controls hide quota content while preserving conversations', async () => {
  let data = sampleSnapshot()
  data.cards.push(...parseCards({ data: [{ provider: 'deepseek', name: 'DeepSeek', balance: '¥42.00', windows: [] }] }))
  const host = mockHost({ requests: {
    'monitor.get': () => data,
    'monitor.quota': input => {
      data = { ...data, showQuota: input.enabled ?? data.showQuota, quotaProvider: input.provider ?? data.quotaProvider }
      return data
    },
  } })
  const view = await mount(panel, { host })
  await view.select({ label: '额度来源' }, 'deepseek')
  assert.ok(view.find({ text: '¥42.00' }))
  assert.equal(view.findAll({ text: '剩余 52%' }).length, 0)
  await view.toggle({ label: '显示网关账号额度' })
  assert.equal(view.valueOf({ label: '显示网关账号额度' }), false)
  assert.equal(view.findAll({ label: '额度来源' }).length, 0)
  assert.equal(view.findAll({ text: '¥42.00' }).length, 0)
  assert.ok(view.find({ text: data.sessions[0].conversation!.title }))
  assert.deepEqual(view.errors, []); assert.deepEqual(view.warnings, []); assert.deepEqual(view.refusals, [])
  await view.unmount()
})
