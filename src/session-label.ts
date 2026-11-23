import type { Session } from './protocol'
import { modelCategory, type ModelCategory } from './model-icon'
import { rate } from './presentation'
export const excerpt = (text: string, length = 80): string => {
  const plain = text.replace(/\s+/g, ' ').trim()
  return plain.length > length ? plain.slice(0, length) + '…' : plain
}
export function sessionTitle(session: Session): string {
  return session.conversation?.title || (session.conversation?.prompt ? excerpt(session.conversation.prompt, 48)
    : `${session.folder.split('/').pop() || session.agent} · ${session.model || '未命名对话'}`)
}
export function sessionLabel(session: Session): string {
  return sessionTitle(session) + (session.subagent ? ' · 子代理' : '')
}
const statusTitleLength: Record<ModelCategory, number> = {
  Claude: 12, GPT: 13, Deepseek: 11, Gemini: 12, Aiden: 13, Traex: 13,
  'byted': 13, Seed: 13,
}
export function statusSessionText(session: Session): string {
  const category = modelCategory(session.requestedModel || '')
  // Allow five more title characters than the original category-specific budgets.
  const limit = category ? statusTitleLength[category] : 17
  const title = Array.from(sessionLabel(session).replace(/\s+/g, ' ').trim())
  const label = title.slice(0, limit).join('') + (title.length > limit ? '…' : '')
  return `${rate(session.averageTPS)}${session.statsSource === 'antigravity-native' ? ' 原生请求均速' : ''} · ${category ? `[${category}] ` : ''}${label}`
}
