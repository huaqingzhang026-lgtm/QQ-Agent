# Pluto DSH bundles

Pluto 的 DSH 端能力，全部以可安装/可停用的 bundle 形式放在各自目录里，由
`qq-bridge/scripts/setup-dsh.mjs` 注册进 profile 的 `dsh.profile.bundles`。

| 包 | 类型 | 内容 |
|---|---|---|
| `pluto-mcp-social` | MCP 配置包 | bilibili / weibo / xiaohongshu |
| `pluto-mcp-media` | MCP 配置包 | image / voice |
| `pluto-mcp-local-llm` | MCP 配置包 | local-llm |
| `pluto-mcp-bridge` | MCP 配置包 | snowluma / snowluma-host / web-search-safe / agent-ops / bili-local |
| `pluto-mcp-android` | MCP 配置包 | android |
| `pluto-memory` | 原生 Host 插件 | 6 个 `mcp__memory__*` 工具（检索/统计/订阅） |
| `pluto-affinity` | 原生 Host 插件 | 5 个 `mcp__affinity__*` 工具（好感度账本） |
| `pluto-status` | Host + Client | 只读看板设置页 + `qq-mode` 模式切换 |

已退役、仅留作回滚：`pluto-mcp-memory`（原 memory / affinity 两条 MCP 行，现由上面两个原生插件取代，**不在** `BUNDLE_NAMES` 里）。

## 安装

```powershell
$env:DSH_HOME = '<工作区>\dsh-home'
$env:QQ_BRIDGE_SKIP_DSH_INSTALL = '1'   # 可选：跳过 pnpm 物化
node qq-bridge\scripts\setup-dsh.mjs web
```

脚本会：建两层 junction（`dsh-home/plugins/<name>` 与 `profile/node_modules/<name>`）、
把包写进 profile `package.json` 的 `dependencies`（`link:`）与 `dsh.profile.bundles`、
清掉 profile 里历史内联的 14 条 `mcp-*` 行。之后重启 DSH 生效。

**移除一个 bundle 时**：先从 `BUNDLE_NAMES` 删名，再手删 profile 的
`dependencies` / `dsh.profile.bundles` 条目与两个 junction（setup-dsh 只加不删），
最后 `dsh plugin --profile web install` 让 pnpm 状态对齐。

## 约定

- **行 id 统一加 `pluto-` 前缀**，避免和 profile 里其它行同 id。
- **`serverName` 保持原值不变**，所以 MCP 工具名仍是 `mcp__bilibili__*` 这类。
- **原生插件沿用 `mcp__memory__` / `mcp__affinity__` 前缀命名**：人格正文、
  `life-loop.mjs` 的心跳台词、`qq-tool-restrict` 白名单都按这两个前缀写死；
  换名会让她照着 prompt 调不存在的工具。前缀在这里只是名字，不代表还走 MCP。
- 切换 MCP 包时顺序必须是「先停旧行，再装新包」，否则同一 `serverName` 会挂载两次。

## 路径

MCP 配置包只打包"那一行"，**不会自动改写路径**。`command` 和 `args` 是本机绝对路径，
换机器时逐个改对应 `cordis.patch.yml`。这是刻意的取舍：集中在一个文件里，比散落在
profile 的 14 处容易维护。

## pluto-status

- `GET /pluto/status`：聚合 `qq-bridge/state/{social-v2,affinity,image-sends,live-watch,sessions}.json`
  与 `token-usage.jsonl`，外加 `qq-mode` 当前值。5 秒缓存、只读、POST 返回 405。
- `GET /pluto/mode`：读 `qq-mode` 的 loader entry config。
- `POST /pluto/mode`：`{"mode":"reserved2"}` → 通过 `configEditor.edit()` 改同名 entry 的
  config（与设置页改名是同一条持久化路径），只允许 `chat / closed-agent / reserved /
  reserved2 / simulation` 五个值，要求 `content-type: application/json`，请求体上限 4KB。
- 客户端半注册 `settings.section`（id `pluto-status`），同源 `fetch` 上面两个接口，
  15 秒刷新，只用 `--dsw-alias-*` 主题 token，不注入 iframe。
- 信任边界：自定义路由不走 DSH 鉴权，只绑本机；返回内容只含聚合值与枚举，不含 API key、
  消息正文或 session token。

## 已修复：好感度工具的守卫缺口（2026-10-27）

`qq-tool-restrict.mjs` 的 `SAFE_PREFIXES` 原先有 `mcp__memory__`、没有
`mcp__affinity__`。后果不是报错，而是**静默失效**：人格正文让她"聊之前先
affinity_get、聊完 affinity_bump"，执行期白名单却整体拒绝 —— 读不到分、记不了账，
那段人设等于空话（`qq-bridge/src` 里没有任何自动注入，全靠模型主动调工具）。

已在该白名单补上 `'mcp__affinity__'`。放行面只有 `state/affinity.json` 这个本地
账本：不改外部状态、不产生公开内容；人设里已写明"不要为了涨分讨好、不要拿好感度
当话题"。

验证方式（真实 `qq-chat-v2` 会话，即挂了守卫的那个 preset）：

- `mcp__affinity__affinity_list` → 被调用、未拒绝、无错误；
- `mcp__affinity__affinity_note` → 被调用、写入 `state/affinity.json` 成功，
  临时条目已删除，账本恢复为 1 条。
