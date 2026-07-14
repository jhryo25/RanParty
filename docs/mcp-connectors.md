# MCP 连接器

RanParty 在 C# 后端中直接托管 MCP 客户端。Electron 仅负责配置、状态展示、OAuth 浏览器跳转和 Elicitation 表单，不转发协议报文。

## 支持范围

- MCP SDK：`ModelContextProtocol.Core 1.4.1`
- 传输：stdio、Streamable HTTP
- 能力：Tools、Resources、Prompts、Roots、Sampling、Elicitation、Logging、Progress、Cancellation、Ping 和动态 `list_changed`
- 导入：Codex `config.toml` 的 `[mcp_servers.*]`、Claude Desktop JSON 的 `mcpServers`
- 认证：静态 Header、Bearer Token、OAuth 授权码 + PKCE、服务发现、动态客户端注册和刷新令牌

不支持旧 HTTP+SSE、MCP Apps、实验性 Tasks、连接器市场，也不把 RanParty 暴露为 MCP Server。

## 添加连接器

1. 打开“设置 → 连接器”，点击“添加”。
2. 选择 stdio 或 Streamable HTTP，并填写命令或 URL。
3. 保存后点击“测试与发现”。
4. 在“工具”页勾选允许使用的工具；需要每轮直接暴露的工具再勾选“常驻”。
5. 确认审批策略后启用连接器并保存。

新发现的能力默认关闭。非“常驻”工具作为 Deferred 工具进入 `tool_search`，只有模型搜索到它之后才加入当前轮 schema。工具名规范为 `mcp__{connector}__{tool}`；非法字符会被清理，超过 64 字符时使用稳定短哈希消除冲突。

## 导入

“导入”支持 `.toml` 和 `.json`。RanParty 会先结构化解析和预览，处理重名后再写入。导入项保持禁用，环境变量和 Header 一律作为秘密迁移；源文件不会被修改，现有 OAuth 会话不会导入。

旧版扁平 `Config/connectors.json` 会迁移到 `schemaVersion: 2` 并保持禁用。迁移后必须重新测试、选择能力并确认新的信任指纹。

## OAuth

HTTP 连接器选择 OAuth 后保存，再点击“OAuth 登录”。后端在 `127.0.0.1` 随机端口创建临时回调监听，Electron 仅在用户点击后使用系统浏览器打开授权 URL。Token 和刷新 Token 使用当前 Windows 用户的 DPAPI 加密，退出登录时删除。

## 安全模型

- env、Header、Bearer 和 OAuth Token 不写入明文 `connectors.json`。
- stdio 仅继承 SDK 的最小环境变量集合，并添加用户明确配置的秘密；Windows 下通过透明 launcher 将服务器加入 `KILL_ON_JOB_CLOSE` Job Object，取消、禁用或应用退出会清理整个子进程树。
- HTTP URL 禁止内嵌凭据；自动重定向关闭，避免认证 Header 被带到其他源。
- 每个工具策略为 `ask`、`auto` 或 `deny`。MCP annotations 只用于界面提示，不能绕过审批。
- Roots 仅在唯一活动 MCP 调用期间返回该调用绑定的工作区。
- Sampling 默认关闭；启用后的上限为 10 RPM、4096 tokens、30 秒、0 个工具轮次，连接器只能进一步收紧。
- Elicitation 必须绑定唯一活动调用。表单支持接受、拒绝、取消和敏感字段遮罩；URL 模式仅在用户确认后打开系统浏览器。
- 工具结果、Resources 和 Prompts 均受大小限制，并继续经过 RanParty 的取消、审计和结果截断链路。

## 配置文件

- `Config/connectors.json`：v2 非秘密配置
- `Config/connector-secrets.json`：DPAPI 密文
- `Config/connector-catalog.json`：有界能力目录缓存，可删除后重新发现

运行状态、错误状态和活动 OAuth/Elicitation 不写入连接器配置。Elicitation 待处理状态通过 Backend Bootstrap 恢复。

## 故障排查

- `not configured`：检查 stdio `command` 或 HTTP `url`。
- 握手超时：直接在终端运行 stdio 命令，确认它只把 MCP JSON-RPC 写到 stdout；普通日志应写 stderr。
- HTTP 连接失败：确认服务提供 Streamable HTTP，而不是旧 SSE endpoint。
- OAuth 反复要求登录：退出 OAuth 后重新登录，并确认系统浏览器能够访问授权服务器和本机回调地址。
- 工具未出现在模型中：先测试发现并勾选工具；Deferred 工具需要通过 `tool_search` 激活，或改为“常驻”。
- 配置变化未生效：点击重连；运行时会按配置指纹和规范化工作区原子替换。

本地协议 smoke：

```powershell
node tests\mcp-connector-smoke.mjs
```
