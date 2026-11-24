import { defineCheck } from 'orca/testing'
import { activeSnapshot, cchostSnapshot, sampleSnapshot } from './fixtures'
const data = sampleSnapshot()
export default defineCheck({
  ready: { requests: { 'monitor.get': () => data } },
  offline: { requests: { 'monitor.get': () => ({ ...data, speedError: '无法读取统计网关，会话速度已暂停更新' }) } },
  running: { requests: { 'monitor.get': () => activeSnapshot() } },
  cchostClaude: { requests: { 'monitor.get': () => cchostSnapshot('claude') } },
  cchostGemini: { requests: { 'monitor.get': () => cchostSnapshot('gemini') } },
  quotaOff: { requests: { 'monitor.get': () => ({ ...data, showQuota: false, cards: [], quotaError: null }) } },
  balance: { requests: { 'monitor.get': () => ({ ...data, quotaProvider: 'deepseek', cards: [{ key: 'deepseek:1', provider: 'deepseek', name: 'DeepSeek', balance: '¥42.00', windows: [], error: null, readAt: null }] }) } },
  multipleAccounts: { requests: { 'monitor.get': () => ({ ...data, cards: [...data.cards, { ...data.cards[0], key: 'example-provider:2', name: 'Example · 账户 2', windows: data.cards[0].windows.map(w => ({ ...w, used: 80, remaining: w.text ? null : 20 })) }] }) } },
})
