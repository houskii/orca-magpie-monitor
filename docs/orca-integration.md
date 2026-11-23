# Orca 本机适配

Orca 插件 API 提供侧栏、命令和状态栏。当前标签页与上游会话标识的映射通过本机只读存储适配取得；点击状态栏后的弹窗由随包附带的 macOS 程序提供。

## 当前会话绑定

从 `orca-profile-index.json` 取得活动 profile，再只读查询对应的 `profile-state.db`。合并状态文档和分片，根据活动工作区、活动标签组及标签页，取得当前 Orca 会话 ID。分屏时使用活动标签组；普通编辑页或远端标签页不套用本机会话。

会话数据优先从 `agent-session-domain.db` 读取。只有新库文件不存在时，才使用旧的 `agent-session-journal.db`；新库存在但无目标记录或读取失败时，不使用旧库中的过期映射。

使用当前 provider handle 对应的原生 ID 精确匹配网关 session，不按模型名、标题或最近活跃时间猜测。找不到测速记录时，界面保留已识别的 agent、模型及思考强度，显示暂无测速数据。

会话绑定跟随 Orca 保存的标签状态，通过文件变更和轮询更新，因此存在保存延迟。适配已在 Orca 1.4.271 验证，内部格式变化时可能需要调整插件。

## 原生 Antigravity 统计

没有网关记录的原生 Antigravity 会话，可根据 Orca provider handle 中的 `nativeId` 和运行时目录，定位 `antigravity-acp/conversations/<nativeId>.db`。先验证会话 ID，再只读访问请求元数据。

适配器按 ACP 1.5.2 的记录格式提取 Token、模型名、请求开始时间、首字等待和流式响应耗时。大字段通过 SQLite 分段跳过，不加载提示词、完整回复或工具正文。单次读取有大小与字段数量上限；格式不支持或统计缺失时，不伪造速度。

原生请求均速使用输出 Token 除以首字等待与流式响应耗时，包含思考输出，排除工具执行和用户停顿。运行时未提供可靠的实时 Token 速度，因此实时显示 `—T/s`。需要 Orca worker 的 Node 支持 `node:sqlite`。

## 弹窗

独立 AppKit `NSPanel` 配合 WebKit 展示 worker 已取得的数据。仅在点击时启动，通过标准输入更新；点击外部或按 Esc 关闭。它不修改 Orca 安装包、不访问私有 RPC，也不开本地服务端口。
