import type { ConversationAgent, QuotaCard, QuotaWindow, Session, Snapshot } from './protocol'
import { isOrca, quotaSelection } from './metrics'
import { ignoredQuotaModel } from './model-filter'
export type Tone = 'neutral' | 'danger' | 'warning' | 'success' | 'accent'
export const speedValue = (s: Session): number => s.averageTPS ?? 0
export const meanLabel = (s: Session): string => s.statsSource === 'antigravity-native' ? '原生请求均速' : '对话生成均速'
export const speedNote = (s: Session): string => s.statsSource === 'antigravity-native'
  ? 'Antigravity 原生记录：输出 token（含思考）÷ 模型请求耗时（含首字等待，不含工具执行和用户停顿）。每个请求结束后更新；未提供实时输出速度。'
  : 'Magpie 会话汇总：生成均速不含首字等待，共用会话的子代理计入主会话。'
export const liveRate = (s: Session): string => rate(s.statsSource === 'antigravity-native' ? null : s.active ? s.liveTPS : 0)
export const isRunning = (s: Session): boolean => s.active > 0 || s.conversation?.running === true
export const activityLabel = (s: Session): string => s.active > 0 ? s.liveTPS ? '正在输出' : '等待 token 输出'
  : s.conversation?.running ? '执行中 · 暂无 token 输出' : '空闲'
export const rate = (v: number | null | undefined): string => typeof v !== 'number' || !Number.isFinite(v) || v < 0
  ? '—T/s' : `${v.toFixed(1).replace(/\.0$/, '')}T/s`
export function conversationAgentLabel(value: ConversationAgent | null | undefined): string {
  if (!value) return ''
  const names: Record<string, string> = { codex: 'Codex', claude: 'Claude', antigravity: 'Antigravity' }
  return [value.agent ? names[value.agent] || value.agent : '', value.model, value.effort].filter(Boolean).join(' / ')
}
export const speedTone = (v: number): Tone => v < 20 ? 'danger' : v < 50 ? 'warning' : v <= 150 ? 'success' : 'accent'
export const quotaTone = (remaining: number | null): Tone => remaining === null ? 'neutral' : remaining <= 20 ? 'danger' : remaining <= 50 ? 'warning' : 'success'
export const orcaSession = (s: Session): boolean => isOrca(s.agent) || !!s.conversation
export const ranked = (sessions: Session[]): Session[] => [...sessions].sort((a,b) => Number(isRunning(b)) - Number(isRunning(a))
  || speedValue(b) - speedValue(a) || b.lastAt - a.lastAt)
export const running = (sessions: Session[]): Session[] => ranked(sessions.filter(s => isRunning(s) && orcaSession(s))).slice(0,3)
export function currentSession(state: Snapshot): Session | undefined {
  const focus = state.focusedConversation
  if (!focus?.session) return undefined
  return state.sessions.filter(s => !s.subagent && s.session === focus.session)
    .sort((a,b) => Number(orcaSession(b)) - Number(orcaSession(a)) || b.lastAt - a.lastAt)[0]
}
export const statusSessions = (state: Snapshot): Session[] => [currentSession(state)].filter((s): s is Session => !!s)
export function currentQuota(state: Snapshot) {
  const session = currentSession(state)
  const source = state.focusedConversation ? session?.quotaProvider || session?.provider || '' : undefined
  const binding = quotaSelection(state.cards, state.quotaProvider, source)
  const model = session?.model || state.focusedConversation?.model || ''
  const ignored = !!ignoredQuotaModel(model, state.ignoredQuotaModels || [])
  return {
    ...binding,
    ignored,
    model,
    provider: ignored ? '' : binding.provider,
    cards: ignored ? [] : binding.cards,
    card: ignored ? undefined : binding.card,
    message: ignored ? '当前模型已跳过账号额度检测。' : binding.message,
    error: ignored ? null : !state.quotaErrorProvider || state.quotaErrorProvider === binding.provider ? state.quotaError : null,
  }
}
export const compactTokens = (v:number|null|undefined):string => typeof v==='number'&&Number.isFinite(v)
  ?new Intl.NumberFormat('en-US',{notation:'compact',maximumFractionDigits:1}).format(v):'—'
export const cachePercent = (v:number|null|undefined):string => typeof v==='number'&&Number.isFinite(v)
  ?(v*100).toFixed(v>0&&v<1&&(v>.999||v<.001)?2:1).replace(/\.0$/,'')+'%':'—'
export function duration(ms:number|null|undefined):string {
  if(typeof ms!=='number'||!Number.isFinite(ms)||ms<0)return '—'
  const seconds=Math.floor(ms/1000),h=Math.floor(seconds/3600),m=Math.floor(seconds%3600/60),s=seconds%60
  const pad=(v:number)=>String(v).padStart(2,'0')
  return `${h?pad(h)+'h:':''}${pad(m)}m:${pad(s)}s`
}
export function resetTime(value: string | null, compact = false): string {
  if (!value || !Number.isFinite(Date.parse(value))) return '未提供'
  if (compact && new Date(value).toDateString() === new Date().toDateString())
    return new Date(value).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })
  return new Date(value).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).replace(/\//g,'-')
}
export function startTime(value:string|null):string{
  return value&&Number.isFinite(Date.parse(value))?new Date(value).toLocaleString('zh-CN',{
    year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false}).replace(/\//g,'-'):'读取中'
}
export const remainingQuota = (remaining: number): string => `${Number(remaining.toFixed(2))}%`
export function quotaLabel(window: QuotaWindow | undefined): string {
  if (window?.text) return window.display || '未提供'
  return window?.remaining === null || !window ? '未提供' : `余${remainingQuota(window.remaining)}`
}
export function quotaWindowName(name: string, pool = ''): string {
  const label = name === '5 hours' ? '5h' : name === '7 days' ? '7d' : name
  return pool && !name.includes(pool) ? `${pool} ${label}` : label
}
export function quotaWindows(card: QuotaCard | undefined): QuotaWindow[] {
  if (!card) return []
  return [...(card.balance ? [{ name: '余额', text: true, display: card.balance, used: null, remaining: null, resetsAt: null }] : []), ...card.windows]
}
