import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import type { Snapshot } from './protocol'
import { quotaSelection } from './metrics'
import { excerpt, sessionLabel } from './session-label'
import { modelIcon } from './model-icon'
import { activityLabel, currentSession, isRunning, liveRate, meanLabel, quotaTone, quotaWindowName, quotaWindows, ranked, rate, resetTime, speedNote, speedTone, speedValue, startTime } from './presentation'

export function popupData(state: Snapshot) {
  const binding = quotaSelection(state.cards, state.quotaProvider)
  const quotaCards = binding.card?.averaged ? [binding.card, ...binding.cards] : binding.cards
  const current = currentSession(state)
  return { error: state.speedError, quotaError: state.showQuota ? state.quotaError : null, checkedAt: state.checkedAt,
    quotas: state.showQuota ? quotaCards.flatMap(card => quotaWindows(card).map(w => ({
      name: `${card.averaged ? binding.label + ' 均值' : binding.cards.length > 1 ? card.name : binding.label} ${quotaWindowName(w.name, w.pool)}`,
      value: w.text ? w.display || '未提供' : w.remaining === null ? '未提供' : `剩余 ${w.remaining}%`,
      remaining: w.remaining, reset: w.resetsAt ? resetTime(w.resetsAt) : '', tone: quotaTone(w.remaining),
      detail: card.averaged ? w.display : '', resetLabel: card.averaged ? '最早重置' : '重置',
    }))) : [], sessions: ranked(state.sessions).map(s => ({
      title: sessionLabel(s), prompt: excerpt(s.conversation?.prompt || '', 100), model: s.model, icon: modelIcon(s.model),
      active: isRunning(s), activity: activityLabel(s), current: s.key === current?.key,
      speed: rate(s.averageTPS), live: liveRate(s), speedLabel: meanLabel(s), speedNote: speedNote(s),
      startedLabel:s.statsSource==='antigravity-native'?'原生首个请求':'Magpie 首个请求',
      startedAt:startTime(s.startedAt),statsError:s.statsError,
      tone: s.averageTPS === null ? 'neutral' : speedTone(speedValue(s)),
    })) }
}
export type MonitorPopup = { update(state: Snapshot): void; show(state: Snapshot): Promise<void>; close(): void }
export function createPopup(log: (message: string) => void): MonitorPopup {
  let child: ChildProcessWithoutNullStreams | null = null
  function send(type: string, state: Snapshot): void {
    if (child && !child.stdin.destroyed && child.stdin.writableLength <= 256*1024)
      child.stdin.write(JSON.stringify({ type, data: popupData(state) }) + '\n')
  }
  return {
    update(state) { send('update', state) },
    async show(state) {
      if (process.platform !== 'darwin') throw new Error('当前弹窗适配 macOS')
      if (!child) {
        const processChild = spawn(fileURLToPath(new URL('../bin/magpie-popup', import.meta.url)),
          [fileURLToPath(new URL('../native/popup.html', import.meta.url))], { stdio: 'pipe' })
        child = processChild
        processChild.once('exit', () => { if (child === processChild) child = null })
        processChild.stdin.on('error', () => {})
        processChild.stderr.on('data', () => { log('Magpie popup reported a native error') })
        await new Promise<void>((resolve,reject) => {
          processChild.once('spawn', resolve)
          processChild.once('error', () => { if (child === processChild) child = null; reject(new Error('无法打开 Magpie 会话弹窗')) })
        })
      }
      send('show', state)
    },
    close() { child?.kill(); child = null },
  }
}
