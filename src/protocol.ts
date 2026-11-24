export type QuotaWindow = { name: string; pool?: string; used: number | null; remaining: number | null; resetsAt: string | null; display: string; text: boolean; samples?: number }
export type QuotaCard = { key: string; provider: string; name: string; windows: QuotaWindow[]; balance?: string; averaged?: boolean; error: string | null; readAt: string | null }
export type ConversationAgent = { agent?: string; model?: string; effort?: string }
export type ConversationPreview = ConversationAgent & { session: string; orcaSession: string; title: string; prompt: string; updatedAt: number; running?: boolean }
export type FocusedConversation = ConversationAgent & { orcaSession: string; session: string; workspace: string; title: string }
export type Session = {
  key: string; session: string; agent: string; folder: string; model: string; requestedModel?: string; provider: string; quotaProvider: string;
  active: number; liveTPS: number | null; runningTPS: number | null; averageTPS: number | null; lastTPS: number | null;
  measuredRequests: number; requests: number; output: number; lastAt: number;
  measuredOutput: number; generationMs: number;
  startedAt:string|null; statsSource:string; statsError:string|null;
  totalTokens?:number|null; cacheHitRate?:number|null;
  state: 'streaming' | 'sampling' | 'waiting' | 'idle'; subagent: string;
  conversation?: ConversationPreview;
}
export type Snapshot = {
  checkedAt: number; cards: QuotaCard[]; sessions: Session[]; quotaError: string | null; quotaErrorProvider?: string;
  showQuota: boolean; quotaProvider: string; ignoredQuotaModels?: string[];
  speedError: string | null; conversationError: string | null; selectedSession: string; baseURL: string;
  omittedSessions?:number;
  focusedConversation?: FocusedConversation | null; focusError?: string | null;
}
export const emptySnapshot = (): Snapshot => ({ checkedAt: 0, cards: [], sessions: [], quotaError: null,
  showQuota: true, quotaProvider: 'auto', ignoredQuotaModels: [],
  speedError: null, conversationError: null, selectedSession: '', baseURL: 'http://127.0.0.1:3425', focusedConversation: null, focusError: null })
declare module 'orca' {
  interface PluginRequests {
    'monitor.get': { output: Snapshot }
    'monitor.refresh': { output: Snapshot }
    'monitor.select': { input: { session: string }; output: Snapshot }
    'monitor.popup': { output: { opened: boolean } }
    'monitor.quota': { input: { enabled?: boolean; provider?: string }; output: Snapshot }
  }
  interface PluginPanelEvents { 'monitor.changed': Snapshot }
}
