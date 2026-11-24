# 网关统计接口

插件默认连接 `http://127.0.0.1:3425`，请求以下 Magpie 风格的统计接口。兼容网关实现相同字段即可接入，无需在插件中增加供应商适配。所有响应为 JSON。

`baseURL` 可以包含路径前缀。例如设置 `https://gateway.example.com/monitor` 后，trace 请求为 `https://gateway.example.com/monitor/v1/magpie/trace`。远程连接使用 HTTPS；HTTP 仅允许 `localhost`、`127.0.0.1` 和 `[::1]`。URL 不接受认证信息、查询参数或片段，响应不跟随重定向。

需要认证时，配置 `bearerTokenEnv` 为环境变量名。worker 将变量值作为 `Authorization: Bearer <value>` 发给网关；未配置时不发送认证头。已配置变量不存在或为空时，不发出请求，并提示检查认证设置。

## 路由快照

`GET /v1/magpie/trace`

```json
{
  "pid": 1,
  "routes": [{
    "id": "request-1", "agent": "orca_desktop", "session": "native-session-id",
    "model": "example-model", "provider": "example-provider", "folder": "example",
    "done": false, "status": 200, "time": "2026-11-23T12:00:00Z",
    "contentAt": 1795435201000, "estTok": 100, "out": 100,
    "ms": 3000, "ttft": 1000, "flow": 2000
  }]
}
```

默认每秒获取。`id` 标识请求；`agent + session + subagentId` 标识会话，缺失 session 的请求不会合并。`estTok` 为流式累计输出计数，`contentAt` 为最近收到内容的毫秒时间戳，`done` 标识结束。`pid` 改变会清除实时采样点。`tries` 的最后一项可提供最终响应模型，`order` 可提供所选供应商信息。

## 会话历史汇总

`GET /v1/magpie/usage/requests?period=all&agent=<agent>&q=<session>&via=through&limit=1`

```json
{
  "total": 2, "decode_out": 400, "decode_ms": 4000, "decode_n": 2,
  "input": 2000, "output": 400, "cache_read": 1500, "cache_write": 0,
  "rows": [{
    "agent": "orca_desktop", "session": "native-session-id",
    "t": "2026-11-23T12:00:00Z", "model": "example-model", "provider": "example-provider"
  }]
}
```

响应的汇总字段覆盖筛选后的整个会话，不能只汇总当前页。`q` 在一些实现中是模糊匹配；插件会核对行内的 `agent` 和 `session`，不把其他会话的数据套进来。`rows` 按时间倒序排列，支持 `offset=total-1` 查询最早一条请求。

`decode_out`、`decode_ms`、`decode_n` 分别为可测速样本的输出 Token、生成耗时毫秒数与样本数；无有效样本时均速未知。Token 与缓存字段以实际支持情况返回，不提供时插件显示未提供。`cache_read`、`cache_write` 为缓存读写 Token，`cache_unknown` 可标识无法确定归属的缓存输入。

## 额度快照

`GET /v1/magpie/quotas?kept=1`

```json
{
  "data": [{
    "provider": "example-provider", "name": "Example", "readAt": "2026-11-23T12:00:00Z",
    "windows": [
      { "name": "5 hours", "pool": "Main", "used": 20, "resetsAt": "2026-11-23T17:00:00Z" },
      { "name": "Wallet", "balance": 42, "unit": "credits" },
      { "name": "Status", "text": true, "display": "Active" }
    ]
  }]
}
```

约每 30 秒获取缓存，不应触发所有供应商同步刷新。百分比窗口可用 `used` 或 `remaining`；余额可用卡片级 `balance` 文本，或窗口级数值 `balance + unit`。`text`、`unlimited` 表示文本或不限额。失败卡片可带 `error`；插件不会展示上游错误原文。

自动模式用当前会话真实请求的供应商匹配额度卡片。还在等待当前会话的路由记录，或网关没有提供对应供应商的额度时，面板显示缺失状态。没有活动会话时，面板显示网关的首个可用来源。同一供应商可返回多个账号卡片。不同额度组用 `pool` 区分，同组同名百分比窗口按有效读数计算账号均值。

当卡片没有 `windows` 时，自定义余额表达式可用 `<窗口名> used` 标记已用百分比，用 `<窗口名> reset` 提供 ISO 8601 重置时间。插件可从 `balanceParts` 或 Magpie 格式化的 `balance` 读出这些窗口。

## 手动刷新额度

`POST /v1/magpie/quotas/refresh?provider=<URL 编码后的来源 ID>`

响应格式与额度快照一致，可以只包含该来源。插件先展示缓存，再刷新选中的一个来源。自动模式会先解析出真实 provider ID；尚未发现来源时不发送 POST。刷新失败保留上次成功读数。

关闭额度后，两个额度接口都不再请求；会话测速继续工作。

## 按模型跳过额度检测

`ignoredQuotaModels` 是插件本机设置，不改变网关的统计接口。规则匹配当前会话的实际模型名，未取得请求记录时使用会话配置的模型。模型命中后，插件不会请求额度快照或额度刷新接口，也不展示缓存额度和额度错误。TPS 与会话 Token、缓存统计仍读取原有接口。自动模式和手动固定来源都遵循忽略规则。规则为空或当前没有可识别模型时沿用正常检测行为。
