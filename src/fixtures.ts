import type { Snapshot } from './protocol'
import { emptySnapshot } from './protocol'
import { SessionMeter, parseCards } from './metrics'
export const instant = Date.parse('2026-11-13T12:00:00Z')
export function rawRoute(id: number, session = 'chat-a', extra: Record<string, unknown> = {}) {
  return { id, agent: 'orca_desktop', session, model: 'gpt-6.1-sol', provider: 'openai', folder: 'personal/Magpie',
    done: true, status: 200, time: new Date(instant + id).toISOString(), out: 200, reasoning: 0,
    ms: 3000, ttft: 1000, flow: 2000, ...extra }
}
export function sampleSnapshot(): Snapshot {
  const sessions = new SessionMeter().ingest({ routes: [rawRoute(1, 'chat-a', { provider: 'example-provider' }), rawRoute(2, 'chat-b', { provider: 'example-provider', out: 100, ms: 5000, flow: 4000 })] }, instant)
  sessions.forEach(session => { const slow=session.session==='chat-b'; Object.assign(session,{ averageTPS:slow?25:100, measuredOutput:slow?100:200, generationMs:slow?4000:2000, measuredRequests:1, startedAt:new Date(instant).toISOString(), statsSource:'magpie' }) })
  sessions.forEach((session, i) => { session.conversation = { session: session.session, orcaSession: `codex-${i}`,
    title: i === 0 ? 'Magpie 网关 用量查询支持' : 'Orca 工作区进度状态',
    prompt: i === 0 ? '另外orca中能展示具体的对话内容吗？而不只是一串id，完全看不懂这是啥呀' : '帮我查看工作区的进度和会话速度。', updatedAt: instant } })
  return { ...emptySnapshot(), checkedAt: instant, selectedSession: sessions[0].key, cards: parseCards({ data: [
    { provider: 'example-provider', name: 'Example', windows: [
      { name: '5 hours', used: 12, resetsAt: '2026-11-13T13:20:00Z' },
      { name: '7 days', used: 48, resetsAt: '2026-11-15T03:00:00Z' },
      { name: '7 days · Fable', used: 0, resetsAt: '2026-11-15T03:00:00Z' },
      { name: 'Snapshot', text: true, display: '2026-11-13T11:59:00Z' },
    ] },
  ] }), sessions }
}
export function activeSnapshot(): Snapshot {
  const data = sampleSnapshot(), seed = data.sessions[0]
  data.selectedSession = ''
  data.sessions = [10,30,80,180].map((v,i) => ({ ...seed, key: `active-${i}`, session: `native-${i}`,
    active: 1, liveTPS: v + 5, runningTPS: v, averageTPS: v, state: 'streaming',
    conversation: { session: `native-${i}`, orcaSession: `orca-${i}`, title: ['低速对话','整理工作区进度','Magpie 用量与速度开发','并发性能分析'][i],
      prompt: '正在生成回复，可以在这里查看均速和实时速度。', updatedAt: instant, running: true } }))
  return data
}

export function cchostSnapshot(source: 'claude' | 'gemini'): Snapshot {
  const state = sampleSnapshot(), model = 'claude-sonnet-5-5'
  const sources = ['claude', 'gemini'] as const
  state.sessions = sources.map((kind, i) => ({
    ...state.sessions[i], session: kind, model, provider: kind + '-cchost', quotaProvider: kind + '-cchost',
  }))
  state.focusedConversation = { session: source, orcaSession: source, title: 'CC Host 会话', workspace: '', agent: 'claude', model }
  state.cards = parseCards({ data: [
    { provider: 'claude-cchost', windows: [{ name: '5 hours', used: 34, resetsAt: '2026-11-13T13:20:00Z' }] },
    { provider: 'gemini-cchost', balance: '5 hours used 12.1% · 5 hours reset 2026-11-13T14:00:00Z · 7 days used 5%' },
  ] })
  return state
}
