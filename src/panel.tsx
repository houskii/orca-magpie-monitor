import { atom, Badge, Button, Callout, Card, Collapsible, Heading, KeyValue, plugin,
  read, RelativeTime, Row, Select, set, Stack, Switch, Text, type PanelContext } from 'orca'
import { emptySnapshot, type Snapshot } from './protocol'
import { quotaSelection } from './metrics'
import { excerpt, sessionLabel } from './session-label'
import { activityLabel, cachePercent, compactTokens, conversationAgentLabel, currentSession, liveRate, meanLabel, orcaSession, quotaTone, quotaWindowName, quotaWindows, ranked, rate, resetTime, speedNote, speedTone, speedValue, startTime } from './presentation'
const snapshot = atom<Snapshot>(emptySnapshot())
const source = atom('session-source-v2', 'all', { persist: 'plugin' })
const busy = atom(false), failure = atom('')
async function refresh(): Promise<void> {
  set(busy, true); set(failure, '')
  try { set(snapshot, await plugin.request('monitor.refresh')) }
  catch { set(failure, '刷新失败，请检查插件日志或统计网关') }
  finally { set(busy, false) }
}
async function showAll(): Promise<void> {
  try { await plugin.request('monitor.popup') }
  catch { set(failure, '无法打开会话弹窗，下方仍可查看全部对话。') }
}
async function configureQuota(input: { enabled?: boolean; provider?: string }): Promise<void> {
  set(busy, true); set(failure, '')
  try { set(snapshot, await plugin.request('monitor.quota', input)) }
  catch { set(failure, '额度设置未保存，请检查插件日志') }
  finally { set(busy, false) }
}
export function setup(ctx: PanelContext): void {
  ctx.subscriptions.push(plugin.on('monitor.changed', payload => set(snapshot, payload)))
  void plugin.request('monitor.get', undefined, { signal: ctx.signal }).then(value => set(snapshot, value)).catch(() => set(failure, '尚未连接 Magpie 插件进程'))
}
export default function Panel() {
  const data = read(snapshot), binding = quotaSelection(data.cards, data.quotaProvider)
  const quotaCards = binding.card?.averaged ? [binding.card, ...binding.cards] : binding.cards
  const sources = [{ value: 'auto', label: '自动选择网关提供的来源' }, ...new Map(data.cards.filter(c => c.provider !== 'auto').map(c => [c.provider, { value: c.provider, label: `${quotaSelection(data.cards, c.provider).label} (${c.provider})` }])).values()]
  if (!sources.some(s => s.value === data.quotaProvider)) sources.push({ value: data.quotaProvider, label: binding.label })
  const sessions = ranked(data.sessions.filter(s => read(source) !== 'orca' || orcaSession(s)))
  return <Stack gap="md">
    <Row justify="between"><Heading>Magpie</Heading><Button icon="refresh" size="sm" variant="ghost" disabled={read(busy)} onPress={refresh}>刷新</Button></Row>
    {(read(failure) || data.speedError || data.showQuota && data.quotaError) && <Callout tone="warning" title="数据暂未更新"><Text>{read(failure) || data.speedError || data.quotaError}</Text></Callout>}
    <Switch label="显示网关账号额度" checked={data.showQuota} disabled={read(busy)} onChange={enabled => { void configureQuota({ enabled }) }} />
    {data.showQuota && <Select label="额度来源" value={data.quotaProvider} options={sources} disabled={read(busy)} onChange={provider => { void configureQuota({ provider }) }} />}
    <Card title="当前会话自动绑定"><Stack gap="xs">
      <Text>{data.focusedConversation ? data.focusedConversation.title || '当前对话' : '当前页面无可绑定的本机会话'}</Text>
      {conversationAgentLabel(data.focusedConversation) && <Text muted size="xs">{conversationAgentLabel(data.focusedConversation)}</Text>}
      <Text muted size="xs">{data.focusError || (data.focusedConversation ? currentSession(data) ? currentSession(data)?.statsSource==='antigravity-native' ? '已关联 Antigravity 原生测速；每个请求结束后更新均速。' : '已关联网关；底栏只显示当前对话，空闲时保留均速。' : data.focusedConversation.session ? '当前对话尚无测速数据，等待请求记录。' : '等待当前对话建立上游会话。' : '底栏等待当前会话，不替换成其他对话。')}</Text>
    </Stack></Card>
    {data.showQuota && <Stack gap="sm">
      <Text muted size="xs">{binding.message}</Text>
      {quotaCards.map(card => <Card title={card.averaged ? card.name : `${card.name} 账号额度`} description={card.averaged ? '同名窗口按账号等权平均，缺失或失败的读数不计入。' : '同一账号的所有对话共享。'}><Stack gap="sm">
        {card.error && <Text tone="warning" size="xs">{card.error}</Text>}
        {quotaWindows(card).map(w => <Stack gap="xs">
          <Row justify="between"><Text weight="medium">{quotaWindowName(w.name, w.pool)}</Text><Badge tone={quotaTone(w.remaining)}>{w.text ? w.display || '未提供' : w.remaining === null ? '未提供' : `剩余 ${w.remaining}%`}</Badge></Row>
          {!w.text && w.display && <Text muted size="xs">{w.display}</Text>}
          {w.resetsAt && <Text muted size="xs">{card.averaged ? '最早重置：' : '下次重置：'}{resetTime(w.resetsAt)}</Text>}
        </Stack>)}
        {!quotaWindows(card).length && <Text muted>尚无额度读数</Text>}
        {card.readAt && <Text muted size="xs">{data.quotaError ? '上次成功读数' : '额度读取于'} <RelativeTime at={Date.parse(card.readAt)} /></Text>}
      </Stack></Card>)}
    </Stack>}
    <Row justify="between"><Heading level={3}>全部对话</Heading><Badge>{sessions.length} 个</Badge></Row>
    <Text muted size="xs">底部只展示当前会话的速度和统计。这里展示全部已观测到的对话。</Text>
    <Text muted size="xs">主会话的历史均速、Token 和缓存统计包含共用会话的子代理；子代理实时速度单独采样。</Text>
    {(data.omittedSessions||0)>0&&<Text muted size="xs">仅保留最近 100 个对话，另外 {data.omittedSessions} 个未展示。</Text>}
    <Button icon="zap" variant="outline" onPress={showAll}>打开全部对话弹窗</Button>
    <Select label="来源" value={read(source)} options={[{ value: 'all', label: '全部已观测对话' },{ value: 'orca', label: 'Orca（已识别）' }]} onChange={value => set(source, value)} />
    {data.conversationError && <Text muted size="xs">{data.conversationError}</Text>}
    {sessions.map(s => <Card><Stack gap="sm">
      <Heading level={3}>{sessionLabel(s)}</Heading>
      <Row gap="sm" wrap><Badge tone={s.averageTPS === null ? 'neutral' : speedTone(speedValue(s))}>{meanLabel(s)} {rate(s.averageTPS)}</Badge>
        <Text muted size="xs">实时 {data.speedError && s.statsSource!=='antigravity-native' ? '0T/s' : liveRate(s)}</Text></Row>
      <Text muted size="xs">{s.model} · {data.speedError ? '采样已暂停' : activityLabel(s)}</Text>
      <Text muted size="xs">累计 Token {compactTokens(s.totalTokens)} · 缓存命中 {cachePercent(s.cacheHitRate)}</Text>
      <Text muted size="xs">{s.statsSource==='antigravity-native'?'原生首个请求':'Magpie 首个请求'}：{startTime(s.startedAt)}</Text>
      {s.statsError&&<Text tone="warning" size="xs">{s.statsError}</Text>}
      {s.conversation?.prompt && <Stack gap="xs"><Text muted size="xs">最近提问</Text><Text size="sm">{excerpt(s.conversation.prompt, 200)}</Text>
        {s.conversation.prompt.length > 200 && <Collapsible title="展开最近提问"><Text size="sm">{s.conversation.prompt}</Text></Collapsible>}
      </Stack>}
      <Collapsible title="测速详情"><Stack gap="xs">
        <KeyValue items={[{label:'可测速输出',value:`${s.measuredOutput} token`},{label:s.statsSource==='antigravity-native'?'模型请求耗时':'有效生成耗时',value:`${(s.generationMs/1000).toFixed(2)} 秒`},{label:'有效样本',value:`${s.measuredRequests}/${s.requests} 条请求`}]} />
        <Text muted size="xs">{speedNote(s)}</Text>
        <Text muted size="xs">工作区：{s.folder || '未提供'}</Text>
        <Text muted size="xs">网关会话 ID：{s.session}</Text>
      </Stack></Collapsible>
    </Stack></Card>)}
    {!sessions.length && <Text muted>尚无对话记录 · 暂无测速数据</Text>}
    <Collapsible title="测速与颜色说明"><Stack gap="sm">
      <Text muted size="xs">均速直接使用 Magpie 返回的会话汇总，服务端排除不可测速样本。工具执行时保留均速；实时仅保留最近约 3 秒、最多 4 个计数点，没有输出时为 0T/s。</Text>
      <Text muted size="xs">只有均速着色：低于 20T/s 红色，20～50T/s 黄色，50～150T/s 绿色，超过 150T/s 紫色。额度按剩余比例：超过 50% 绿色，20%～50% 黄色，20% 及以下红色。</Text>
    </Stack></Collapsible>
    {data.checkedAt > 0 && <Text muted size="xs">速度更新于 <RelativeTime at={data.checkedAt} /></Text>}
  </Stack>
}
