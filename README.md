# QQ Agent

QQ Agent 是一个自主社会型虚拟人项目：在 QQ 会话中保持虚拟身份、个人边界、长期记忆、关系与自主选择，通过桥接和 MCP 工具执行受控动作。

本仓库是经过隐私整理的开发快照，供代码阅读和离线研究。公开整理改变了示例标识、机器路径和生成文件，因此本副本不能直接继承内部候选的哈希或验收结论。完整 bridge / DSH / QQ / MCP 进程联调、真实模型人格体验及线上验收尚未完成。

## 目录

- `project/qq-bridge/`：OneBot 与 DeepSeek Harness 桥接、管理界面、角色预设和相关模块。
- `project/memory-mcp/`：记忆检索与相关 MCP 接口。
- `project/image-mcp/`、`project/local-llm-mcp/`：媒体和本地模型接口。
- `project/tools/`：人格构建、离线测试、记忆维护和可选自动任务。
- `project/bundles/`：DSH bundle 示例；使用前需调整安装路径和依赖。
- `tools/check-public-release.mjs`：公开文件检查。

## 本地准备

需要 Node.js 22.13 或更高版本，以及自行配置的 DeepSeek Harness 和兼容 OneBot v11 的 QQ 适配器。适配器、模型服务、浏览器登录态和运行数据不随本仓库提供。

```powershell
cd project/qq-bridge
npm ci
Copy-Item config.example.json config.json
```

按自己的环境填写 `config.json`：连接地址、管理员账号、准入列表和令牌。保持管理服务仅监听本机；完成配置后再考虑运行。安装依赖会执行仓库内的 SDK 导入兼容补丁，依赖许可说明见本目录的 LICENSE。

`project/bundles/` 中的 `C:/QQ-Agent/project` 和 `C:/Users/example` 均为示例路径；需替换为本机安装位置。高级运维工具通过 `DSH_NODE`、`DSH_RUNTIME`、`PNPM_CLI` 和 `DSH_CLI` 接受运行时路径。中转模型地址需自行配置，`relay.example.invalid` 不是真实服务。

个人角色插画、语音素材和其他二进制资源未包含在公开包中。自我形象图片接口缺少素材时会返回缺失提示；需要时自行提供有权使用的素材。

## 离线检查

```powershell
# 在仓库根目录检查公开文件
node tools/check-public-release.mjs

# 只列出测试，不连接真实平台
cd project
node tools/personality-tests/run.mjs --list
```

更多测试入口见 [测试说明](project/tools/personality-tests/README.md)，本次结果和已知失败见 [公开整理验证](docs/VALIDATION.md)。部分历史测试需要外部运行时或额外的合成 fixture；测试通过不能代表真实账号验收。不要用真实凭据或真实群进行离线回放。

## 公开范围

本仓库不包含原始聊天、日记、浏览器 profile、Cookie、密钥、运行状态、内部审查交接、迁移清单或阶段交付日志。示例账号和群标识是合成数据，不应作为真实发送目标。

原始开发资料保留在独立的私有仓库中。后续公开更新也应通过整理后的发布副本进行，避免合并含私人资料的开发历史。整理说明见 [公开版本说明](docs/PUBLIC_RELEASE.md)。

## 许可与依赖

保留各组件已有的许可、版权和第三方说明，见 [qq-bridge/LICENSE](project/qq-bridge/LICENSE)。本次公开整理没有新增对其他组件的整体许可授权，也不分发 QQ 适配器或其二进制文件。
