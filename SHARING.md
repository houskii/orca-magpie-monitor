# 安装与分享

这个包是 Orca 的用量与速度监控插件。它直接读取 Magpie 或兼容网关提供的统计数据，不附带供应商适配器、账号配置或密钥。

## 从 GitHub 安装

```sh
orca plugin install houskii/orca-magpie-monitor
```

固定到当前版本：

```sh
orca plugin install houskii/orca-magpie-monitor@v0.4.2
```

Orca 会先显示插件来源和权限。首次安装按返回的说明完成授权。更新时再次运行安装命令即可；已有设置保留。

## 从 ZIP 安装

从 [GitHub Releases](https://github.com/houskii/orca-magpie-monitor/releases) 下载 `orca-magpie-monitor-0.4.2-macos-universal.zip` 并解压，将目录放在准备长期保留的位置：

```sh
orca plugin install /absolute/path/orca-magpie-monitor
```

包中弹窗同时支持 Apple Silicon 和 Intel Mac。开发者可从 Swift 源码重新构建。

## 配置数据来源

在 **Orca → Settings → Plugins → Magpie 用量与速度** 中设置网关地址。默认连接本机 Magpie：`http://127.0.0.1:3425`。其他端口、远程 HTTPS 和路径前缀也可配置。

账号额度默认使用 `auto`，从网关返回的数据中选择首个有效来源。可以在面板里固定来源，或关闭账号额度，只保留速度、Token 和缓存统计。旧版本保存的来源不会被覆盖，需要时手动改成 `auto`。

需要跳过某些模型的额度检测时，在 **忽略额度检测的模型** 中填 `gpt, gemini` 等规则。支持模型名前缀和 `*` 通配符；命中后不查询、不展示账号额度，也不提示额度读取失败，测速和会话统计继续工作。

网关要求 Bearer 认证时，在设置中填写环境变量名，例如 `MAGPIE_MONITOR_TOKEN`，并确保该变量对 Orca 的 worker 进程可见。变量值不要填在网关 URL 或来源 ID 中。

请求需要经过配置的网关，才能产生对应的网关测速记录。其他网关应实现 [统计接口约定](docs/gateway-api.md)。原生 Antigravity 的本机统计可独立工作，支持范围见 [Orca 适配说明](docs/orca-integration.md)。

## 构建分享包

在源码目录运行：

```sh
npm ci
orca plugin types . --json
npm run typecheck
orca plugin test . --json
npm run stage
python3 scripts/package-share.py --output .local/releases
orca plugin validate .local/package --json
```

脚本生成监控插件 ZIP 和 `magpie-monitor-SHASUMS.txt`。不会打包本机诊断、账号配置、密钥、开发依赖或其他插件。
