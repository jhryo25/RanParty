# RanParty Codex 对齐实现计划（1-联网查询缓存 / 2-工具结果缓存 / 4-exec 沙箱）

> 参照 Codex `codex-rs` 源码调研结论，按 1→2→4 顺序实现。3（MCP 批发）本次不做。

> 2026-07-11 状态：本文是历史设计，文中旧绝对路径不再作为实施依据。搜索缓存和工具结果 `cache_id` 已落地。Shell 现为每命令独立 Job Object，kill-on-close 且 job 内存上限 512MB；默认超时 60 秒，允许 1–3600 秒，stdout/stderr 各限 65,536 字符。它仍不是 AppContainer/VFS 文件系统沙箱，不应称为完整 exec 隔离。

## 1. 联网查询缓存

### 1a. 新增 `SearchCache.cs` — SQLite 缓存引擎
- **文件**：`Core/SearchCache.cs`
- **位置**：`F:\py project\RanParty\Core\SearchCache.cs`
- **依赖**：在 `RanParty.csproj` 加 `<PackageReference Include="Microsoft.Data.Sqlite" Version="9.0.0" />`
- **类**：`public sealed class SearchCache`
- **构造**：`SearchCache()` → 在 `CatTemp/search_results.db` 打开/创建 SQLite 数据库
- **建表**（首次）：
  ```sql
  CREATE TABLE IF NOT EXISTS results (
    key TEXT PRIMARY KEY,
    result_json TEXT NOT NULL,
    provider TEXT NOT NULL,
    created_at INTEGER NOT NULL
  )
  ```
- **API**：
  - `bool TryGet(string query, out string resultJson, TimeSpan ttl)` — 查 key=SHA256(query)，TTL 默认 24h，过期返回 false
  - `void Put(string query, string resultJson, string provider)` — 插入/更新（key=hash，provider=来源）
- **并发**：单实例 ConcurrentDictionary 缓存热点 + SQLite 为持久层。用锁保护 SQLite 写（SQLiteConnection 单线程）。

### 1b. WebCat 加缓存工具 `web_search_cached` / `web_fetch_cached`
- **修改**：`Cats/WebCat.cs`
- 构造函数接收 `SearchCache`（DI 注入）：
  ```csharp
  public WebCat(Config cfg, SearchCache cache) { ... }
  ```
- 新增工具注册：
  - `web_search_cached(query, count)`：先调 `cache.TryGet(query, out cached)`，命中返回 `{"cache":"hit",...}`，未命中调 `Search()` 后 `cache.Put()` 并返回 `{"cache":"miss",...}`
  - `web_fetch_cached(url, count?)`：同上逻辑，但 TTL 7 天，cache key=url
- `Execute` switch 加 `"web_search_cached"`, `"web_fetch_cached"` 分支

### 1c. ApiClient deepseek provider 感知 `online:true`
- **修改**：`Core/ApiClient.cs`
- `ChatResult Chat(string model, List<JsonNode> messages, ...)` 中检测 provider：
  - 若 `_baseUrl` 含 `deepseek` 或 `api.deepseek.com`，在最后一个 user message 的 content 前缀加 `[SEARCH:true]` 标记，并将请求体 `tools` 改为包含 `web_search_preview` tool
  - **或更好**：Ref deepseek 文档，用 `chat.completions` 的 `tools` 数组包含 `{"type":"web_search_preview"}`；DeepSeek 会在 assistant 消息的 `tool_calls` 中返回搜索调用，模型回复 content 后跟 `annotations` 含 URL。需要分析 `ChatResult` 结构拼接搜索结果到消息体
- **保守方案**（避免破坏现有协议）：
  - 在 `ApiClient` 构造时存 `_provider = "deepseek" | "openai" | "anthropic"`（从 baseUrl heuristics 推断）
  - 仅在 `_baseUrl.ToLower().Contains("deepseek")` 时加 `"search":{"enabled":true}` body 字段（deepseek v3/v4 协议）
  - 结果处理：解析 `ChatResult` 的 `choices[0].message.search_results`（如存在），拼接到 assistant content 后作为 `${content}\n\n[Web Search Results]\n${formatted}`

### 1d. BackendHost BuildToolsSchema 加新工具
- **修改**：`backend/BackendHost.cs`
- Schema 末尾加 `web_search_cached`、`web_fetch_cached`（参照现有 web_search 描述）
- `DispatchWithApprovalAsync` 加路由：`if (name == "web_search_cached" || name == "web_fetch_cached") return ...`

---

## 2. 工具结果结构化缓存

### 2a. tool message 存 cache_id + summary + tool_output_lookup
- **修改**：`backend/BackendHost.cs` `RoundTripAsync` 工具结果插入处
- 每个工具执行后生成 `cacheId = $"{sessionId}_{name}_{Guid.NewGuid():N}"`，存入内存 `ConcurrentDictionary<string, string> _toolOutputs`
- tool message 改动：
  ```json
  {
    "role": "tool",
    "name": "...",
    "content": "<truncated_or_full>",
    "cache_id": "abc123",
    "summary": "前 200 字符摘要",
    ...
  }
  ```
- 新增工具 `tool_output_lookup(cache_id, offset=0, limit=8000)`：
  - 从 `_toolOutputs` 取完整结果，返回 `[offset..offset+limit]` 片段
  - 在 dispatch 表加 `"tool_output_lookup"` → `ToolOutputLookup(args)`

### 2b. TruncateToolResult 智能截断
- **修改**：`backend/BackendHost.cs` `TruncateToolResult` 方法
- 超阈值时输出摘要模式：
  ```
  [摘要] <前 200 字符>
  ...
  [已截断：原始 XX 字符。使用 tool_output_lookup("cache_id", offset) 分段读取]
  ```
- `cache_id` 从调用处传入

---

## 4. exec 沙箱化

### 4a. ShellCat Windows Job Object 沙箱
- **修改**：`Cats/ShellCat.cs`
- 导入内核函数：
  ```csharp
  [DllImport("kernel32.dll")]
  static extern IntPtr CreateJobObject(IntPtr attr, string name);
  [DllImport("kernel32.dll")]
  static extern bool SetInformationJobObject(IntPtr hJob, int infoType, IntPtr info, uint infoLen);
  [DllImport("kernel32.dll")]
  static extern bool AssignProcessToJobObject(IntPtr hJob, IntPtr hProcess);
  ```
- 在 `ps_run` 执行处（`Process.Start` 前/后），为子进程创建 Job Object：
  - `JobObjectExtendedLimitInformation(2)` + `LimitFlags = 0x2000 /*KILL_ON_JOB_CLOSE*/ + 0x10 /*ACTIVE_PROCESS=1*/`
  - `AssignProcessToJobObject` 子进程
  - 效果：父进程 crash/kill 时子进程即时清理；限制子进程只能有 1 个进程（防 fork 守护）
- 注：WinForms `FMain.cs` 里的 ShellCat 也需同步改动（同一类）

### 4b. 时间预算 + 输出截断
- **修改**：`Cats/ShellCat.cs` `ps_run` 执行处
- `Process.StartInfo` 设 `RedirectStandardOutput/Error = true`（已存在）
- 新增 `_outputCts = new CancellationTokenSource()` + `Task.WhenAny(process.WaitForExitAsync(), Task.Delay(60_000, cts))` 超时逻辑
- 超时时 `process.Kill(true)` + 返回 `已截断：命令 60 秒超时。stdout/stderr 前 16KB：`
- 非超时时捕获全部输出（最多 16KB 前缀）

### 4c. 路径白名单守卫
- **修改**：`Cats/ShellCat.cs`
- `write` 工具（`file_write`/`file_append` 等写操作）执行前加校验：
  - 路径必须已规范化（`Path.GetFullPath`）
  - 路径不能含 `..` traversal
  - 路径不能以 `C:\Windows\`、`C:\Program Files\`、`C:\Program Files (x86)` 开头
  - 路径必须在 `_cfg.Whitelist` 中（已有，`Config.cs` 构建白名单）
- `delete` 操作同理 + 额外检查不在 `C:\Users\<user>\AppData\` 等配置目录

---

## 构建与验证
- `dotnet build` backend（0 error 要求）
- `dotnet publish` backend-publish-v4
- `npm run package` electron portable exe
- 启动验证：搜一个词两次（第二次应 hit cache）、run `echo hello` 应被 Job Object 约束、工具结果超长应出现 cache_id 摘要

---

## 改动文件清单
| 文件 | 改动 | 笔数 |
|---|---|---|
| `Core/SearchCache.cs` | **新增**：SQLite 缓存引擎 | ~100 行 |
| `RanParty.csproj` | 加 Microsoft.Data.Sqlite 依赖 | 1 行 |
| `Cats/WebCat.cs` | 加 cached 工具、接收 SearchCache DI | ~60 行 |
| `Core/ApiClient.cs` | deepseek provider 感知 online:true | ~40 行 |
| `backend/BackendHost.cs` | Schema 加新工具、路由、tool_output_lookup、TruncateToolResult 改进 | ~80 行 |
| `Cats/ShellCat.cs` | Job Object 沙箱、时间预算、路径白名单 | ~80 行 |
| `Core/Config.cs` | 白名单附加系统目录排除（如有不足） | ~10 行 |
