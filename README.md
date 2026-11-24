# Orca Magpie Monitor

在 Orca 中查看当前对话的生成速度、累计 Token、缓存命中率和账号额度。数据来自你配置的 Magpie 或兼容网关；插件不内置供应商适配器。

- 底栏自动跟随当前标签页，显示当前会话的速度和用量。
- 侧栏和 macOS 弹窗显示已观测到的全部对话、模型和执行状态。
- 额度默认跟随当前会话实际使用的供应商，也可手动固定来源或关闭。
- 支持百分比窗口、分组额度、积分、余额和文本状态；多账号可查看均值及明细。
- 兼容 Orca 的 journal、domain 会话存储。没有网关测速记录时，仍可显示已识别的 agent、模型和思考强度。
- 原生 Antigravity 会话可读取本机运行时统计，不要求请求经过 Magpie。

当前版本 **0.4.2**。适用于 macOS 12+、Orca **1.4.258+**。弹窗包含 Apple Silicon 与 Intel 通用二进制。已在 Orca 1.4.271 验证存储兼容。Antigravity 原生统计适配 ACP 1.5.2，并需要 worker 支持 `node:sqlite`。

## 安装

```sh
orca plugin install houskii/orca-magpie-monitor
```

也可固定版本：

```sh
orca plugin install houskii/orca-magpie-monitor@v0.4.2
```

首次安装时，Orca 会显示插件权限和来源。检查后，按 Orca 返回的命令完成授权；每个安装者使用自己机器上生成的授权信息。

离线 ZIP 安装与更新方式见 [安装和分享](SHARING.md)。

## 连接网关

打开 **Orca → Settings → Plugins → Magpie 用量与速度**：

| 设置 | 默认值 | 含义 |
| --- | --- | --- |
| 统计网关地址 | `http://127.0.0.1:3425` | Magpie 或兼容网关的根地址，可含路径前缀。远程连接使用 HTTPS。 |
| 额度来源 ID | `auto` | 跟随当前会话实际用的供应商。没有活动会话时，选择网关返回的首个有效来源。也可固定为指定来源。 |
| 忽略额度检测的模型 | 空 | 例如 `gpt, gemini`。匹配模型系列或 `*` 通配符，跳过额度查询和展示，保留 TPS、Token 和缓存统计。 |
| 显示网关账号额度 | 开启 | 关闭后停止额度请求，保留会话速度与用量。 |
| 网关 Token 环境变量 | 空 | 需要 Bearer 认证时，填写 Orca worker 可见的环境变量名。不要填写 Token 本身。 |
| 速度采样间隔 | 1 秒 | 可设置为 1～10 秒。 |

额度属于账号，同一个账号的多个会话共享额度。自动模式随当前会话切换，手动模式保持所选来源。比如 Claude 模型走 `gemini-cchost` 时，自动模式显示 cchost 的 Gemini 额度。点击刷新只查询当前显示的来源。

忽略规则不区分大小写，可用逗号、空格或换行分隔。`gpt` 匹配 GPT 系列，`gemini*` 匹配 Gemini 系列，`*flash*` 匹配名称中含 flash 的模型。带供应商前缀的模型名也能匹配，例如 `gateway/gpt-6`。规则优先匹配当前会话实际返回的模型；还没有请求记录时，使用会话配置的模型。模型命中后，即使手动固定了额度来源，也不会请求该来源。切换到其他模型后自动恢复检测。

其他网关需要实现 [统计接口约定](docs/gateway-api.md)。仅兼容 OpenAI 或 Anthropic 的聊天接口，不能提供历史会话速度和账号额度。

从旧版本更新时，已有的手动来源设置会保留。希望改用自动发现时，把额度来源改成 `auto`。

## 速度和用量

TPS 是每秒生成的 Token 数。这里的 Token 是模型处理文字的计量单位。

| 显示项 | 计算方式 |
| --- | --- |
| 对话生成均速 | 读取网关的会话汇总，使用 `decode_out × 1000 / decode_ms`。只计算可测速样本，不计首字等待、工具执行或用户停顿。 |
| 实时速度 | 根据最近约 3 秒、最多 4 个输出计数点采样。并行请求在同一会话内相加；子代理单列。 |
| 原生请求均速 | Antigravity 本机统计的输出 Token 除以首字等待与流式响应耗时。包含首字等待，每个请求结束后更新，与网关生成均速分开标注。 |
| 累计 Token | 会话累计输入、输出及缓存读写 Token。 |
| 缓存命中率 | 缓存读取 Token 占总输入 Token 的比例；来源未提供时显示未提供。 |
| `0T/s` / `—T/s` | 已知当前无输出显示 0；缺少有效数据或没有可关联记录显示破折号。 |

工具执行或空闲时保留历史均速。主会话历史汇总包含共用 session ID 的子代理；共享 ID 的子代理不重复展示同一份历史汇总。

## 数据访问

插件通过 Orca 的可信 Node worker 请求配置的网关，读取插件自己的设置和存储。自动会话绑定只读访问本机 Orca 的当前标签状态、会话标识、标题、最近提问及模型元数据。Antigravity 适配只读提取本机会话数据库中的统计字段。

插件不读取供应商登录凭据，也不直接请求供应商额度接口。可选的 Bearer Token 从指定环境变量读取，只发给配置的网关，不进入面板快照或日志。网关请求拒绝重定向，响应大小限为 2 MiB。

会话绑定和 Antigravity 原生统计依赖本机存储格式，相关边界见 [Orca 适配说明](docs/orca-integration.md)。

## 开发与打包

需要 Node.js、npm、运行中的 Orca，以及 Xcode Command Line Tools。

```sh
npm ci
orca plugin types . --json
npm run typecheck
orca plugin test . --json
orca plugin check . --json
npm run stage
python3 scripts/package-share.py --output .local/releases
orca plugin validate .local/package --json
```

`stage` 会从 Swift 源码构建两种架构的弹窗、合并为通用二进制并进行临时签名，再准备安装目录。仓库内保留构建好的弹窗，因此从 GitHub 安装无需编译。

测试使用合成数据，不包含本机账号配置、对话记录或诊断截图。离线分享包只含运行文件和说明；打包脚本不接收供应商适配器参数。

## 许可

代码采用 [MIT License](LICENSE)。品牌图标来源及上游许可见 [NOTICE](native/icons/NOTICE.md)。
