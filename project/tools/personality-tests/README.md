# personality-tests：A00-rework1 隔离测试环境（B01/B02/B03）

本目录是 A00 返工后的测试设施。旧版只做“参数门禁 + mock 对象自检”；本版在**任何
mkdir/write/spawn 之前**做路径预检，并对**实际子进程**施加写/网络 I/O 边界。

## 入口

```powershell
# 列出清单（不运行，不写文件）
node tools/personality-tests/run.mjs --list

# 运行基线（必须显式 --offline；默认把 LIVE 根视为只读 forbidden）
node tools/personality-tests/run.mjs --offline `
  --data-root "$env:TEMP\personality-tests-run" `
  --report "C:\...\A00-rework1\evidence\tests" `
  --forbid-root "C:\...\additional-forbidden-dir" `
  --protect-root "C:\...\extra-protected-dir" `
  --allow-endpoint 127.0.0.1:39001
```

可选参数（均可重复）：`--forbid-root <path>`、`--protect-root <path>`、
`--allow-endpoint <host:port>`、`--write-root <dataRoot 内的子目录>`。
清单条目可选字段：`writeRoots`（只允许 dataRoot 内子目录）、`allowEndpoints`。

## 预检（B01，先于任何写/spawn）

- 解析并 realpath 所有最终目标：`--data-root`、`--report`、`--manifest`、每个 case 的
  `script`/`cwd`/args 中像路径的参数、每个 case 日志路径、policy/violations 路径。
- 最近存在祖先 realpath + junction/symlink 别名解析（含中间目录）、Windows 大小写归一、
  相对路径按进程 cwd 解析。
- 拒绝：目标落在 forbidden（内置 LIVE 根 + `--forbid-root`）或 protected roots 内；
  dataRoot 与 report 相同/互相包含；输出与输入（manifest/脚本）相同/互相包含；
  report 是已存在文件；脚本路径含生产启动器（`tools/hidden/**`、`run-*.cmd`、
  `start-*.cmd`、`stop-*.cmd`、`restart.bat`、`qq-bridge/src/bridge.js`、`life-loop.mjs`、
  `send-qq.mjs` 等）——即使被 `--filter` 排除也拒绝整个 run。
- 失败语义：**0 执行、不创建 dataRoot**；只允许把 `preflight-failure.json` 写入
  独立验证安全的 report 目录；report 本身不安全时只输出 stderr 并退出非零（2）。

## 子进程隔离（B02）

- 子进程以 `node --import isolation/preload.mjs <script>` 启动；同时把同一 preload
  放进 `NODE_OPTIONS`，让测试再 spawn 的 node 孙进程递归继承。
- `isolation/preload.mjs` 读取 `dataRoot/policy/case-*.json`（缺失/不在 dataRoot 内 => fail-closed）：
  - `node:fs` / `node:fs/promises` 的写/建/改/删类 API（sync/callback/promise/stream/fd，
    含 open 写标志、mkdtemp、rm、rename、copy、chmod/chown/utimes、FileHandle 写方法等）
    默认只允许 `dataRoot`、`report`、`TEMP/TMP`、`--write-root`/case `writeRoots`；
    policy 目录、violations/self-ports 文件对子进程 deny。
  - 网络：`fetch`、`WebSocket`、`node:http(s).request/get`、`node:net.connect`、
    `node:tls.connect` 默认拒绝；只允许 `--allow-endpoint host:port`，以及本次 run 内
    任意进程 `net.Server.listen` 的 loopback/本机通配端口（共享注册表
    `dataRoot/policy/self-ports.jsonl`，父子/兄弟进程可互相连接自建 fixture）。
  - 违规在系统调用前抛错（async 为 rejected promise），追加
    `dataRoot/policy/violations.jsonl`；`no-violations` 门禁失败。
- 词法例外：路径**词法上**落在 writeRoots 内、但 realpath 失败仅因某祖先不是目录（如测试故意把
  `nope-<pid>` 建成文件再写其子路径）时，交给 OS 自然失败（OS 不会写到根外），不算越界违规；
  词法越界仍拒绝（相邻 probe：review-repro N21）。
- stdout/stderr 是 pipe 不是文件写，不拦。

## A00-rework2 追加防护（C01/C02/C03）

- **C01 硬链接**：`link/linkSync/fs.promises.link` 校验来源（必须在 writeRoots 内、非 deny/protected、
  非未知 nlink>1）与目标；写操作（含 open 写/stream/FileHandle/copy 目标）写前 `stat` 当前真实
  目标，`nlink>1` 且非本进程受控 link inode => 拒绝。允许根内唯一来源创建的新链接可写。
  删除/rename 使用 link-entry 语义（父目录 realpath + basename，不解析 final junction 目标）。
- **C02 无永久缓存**：每次写按当前 realpath 重新判定；rename+junction 顺序攻击写前拒绝。
- **C03 受控子进程**：patch spawn/spawnSync/exec/execSync/execFile/execFileSync/fork；Node 后代强制
  `process.execPath` + `--import preload` + 强制策略 env（即使 env={} 或清空 NODE_OPTIONS）；
  非 Node、`shell:true`、字符串 shell 命令在副作用前拒绝；Worker 注入 execArgv（eval worker 前置
  `require(preload)`）。残余边界见 A00-rework2 evidence/isolation/design.md。
- **expectViolations**：仅受信 manifest 可声明，用于 selftest 这类必须故意触发违规的自检；runner
  按 policy caseId 归属，expected 之外任何违规仍使 `no-violations` 失败，且 expected 用例必须真实
  产生违规。

## 变化门禁（B03）

- 运行前后快照 protected roots：candidate `qq-bridge/{src,scripts,dsh,plugins,state}`、
  `agent-home`；LIVE `qq-bridge/{src,scripts,dsh,plugins}`、`qq-bridge/config.json`、`tools`；
  以及所有 `--protect-root`。
- 新增/修改/删除、目录不可读 => `protected-unchanged` 门禁失败并列出 root/path/change；
  合法 dataRoot/report 产物不在 protected 内，不误报；新文件不会自动进白名单。
- LIVE 常驻进程持续写的运行时目录（`state`、`agent-home`、`dsh-home`、`memory-mcp`、
  `qq-bridge/state` 等）与 `tools/*.log`、`keepalive-state.json` 排除在失败门禁外，
  在报告 `protected.excludedLiveRuntime` 单列。事后快照只作补充，不能替代 B02 写前阻断。

## 门禁（任一失败 => 退出码 1；预检失败 => 2）

| 门禁 | 含义 |
|---|---|
| `manifest-load` / `cases-nonempty` | 清单不可读或空用例失败 |
| `offline-flag-required` / `data-root-required` / `report-dir-required` | 必需参数 |
| `preflight` / `forbidden-path` / `protected-path` | 写/spawn 前路径安全 |
| `case-load` / `subprocess-nonzero` / `required-skipped` | 原回归门禁 |
| `no-violations` | 子进程写/网络违规为 0 |
| `protected-unchanged` | protected roots 无变化且可读 |
| `report-written` / `report-safe` | 报告写出、可解析、位置安全 |

报告 `run-report.json` 包含：runner/preload/paths lib sha、manifest sha、每 case 源码 sha、
注入方式、策略内容、violations、protected 变化清单、逐 case 退出码与日志路径。

## 文件

- `run.mjs`：统一入口（B01 预检 + B02 注入 + B03 快照 + 门禁/报告）。
- `lib/paths.mjs`：路径归一/realpath/别名/边界/生产启动器识别（纯函数，不 import fs）。
- `isolation/preload.mjs`：子进程 fs/网络拦截（由 runner 经 `--import` 注入）。
- `cases.baseline.json`：A00 基线用例清单（仅 offline-safe）。
- `selftest-isolation.mjs`：真实子进程隔离自检（18 项）。
- `mocks/`、`fixtures/`：原有 mock/dataRoot 工具与失败 fixture，保留不变。
