# RanParty 待实现特性 — 详细设计

> 2026-07-08 | 基于 Hermes/Codex 对比分析

---

## P0: Pre/Post Tool Hooks

### 是什么

在每次工具执行前后插入钩子点，让代码能拦截/修改/记录工具调用。借鉴 Codex 的 `PreToolUsePayload` / `PostToolUsePayload`。

### 为什么是 P0

当前所有扩展都在 BackendHost 里硬编码（审批门控、危险命令检测、遥测记录），加一个新功能就要改主流程。Hook 打开后：输出校验、埋点、A/B 测试、第三方插件，都可以不改 BackendHost。

### 实现设计

```
工具执行流:
  args → [PreHook] → 原 Execute() → [PostHook] → result

Hook 签名:
  PreHook(string tool, JsonNode args) → (JsonNode? modifiedArgs, ToolResult? blockResult)
  PostHook(string tool, JsonNode args, ToolResult result) → ToolResult
```

### 改动范围

| 文件 | 改动 | 行数 |
|------|------|------|
| `Core/ToolHooks.cs` (新) | Hook 注册、链式调用 | ~40 |
| `Cats/CatRegistry.cs` | Dispatch 方法插入 pre/post | ~10 |
| `backend/BackendHost.cs` | 现有逻辑迁移为默认 Hook | ~30 |

### 示例：把现有功能变成 Hook

```csharp
// 危险命令检测 → PreHook
hooks.AddPre("shell_run", (tool, args) => {
    var check = CheckDangerousCommand(args["command"]);
    if (check != null) return (null, check); // block
    return (args, null); // pass through
});

// 工具遥测 → PostHook
hooks.AddPost("*", (tool, args, result) => {
    Emit("tool.completed", new { durationMs = sw.Elapsed, ... });
    return result;
});
```

### 风险

低。只是在 Dispatch 方法里插两行，不改变现有行为。

---

## P1: LLM 驱动的 Curator 合并

### 是什么

冷归档无限增长时，不是简单删旧条目，而是让一个廉价模型扫描冷归档，合并重叠条目、提取高频 pattern 升级到热存储。

### 为什么是 P1

当前的 `curator_review` 只计数——告诉你有多少条、哪些过时，但不做智能压缩。冷归档运行几周后会变成 500+ 条，BM25 检索效率下降，AI 需要翻很多条才能找到相关经验。

### 实现设计

```
curator_review 增强版:
  1. 扫描 LESSONS_archive.md 所有条目
  2. 用 BM25 聚类相似条目（两两比较 KeywordOverlap > 0.6 → 同类）
  3. 对每组同类 → fork AIAgent(cheap model)
     → prompt: "合并以下踩坑记录为一条 LESSONS.md pattern"
     → 结果写入 LESSONS.md（热）
     → 原条目标记 [merged→LESSONS.md]
  4. 对单一孤立条目 → 不变
  5. hits > 3 的条目 → 单独升级
  6. 输出整理报告
```

### 改动范围

| 文件 | 改动 | 行数 |
|------|------|------|
| `backend/BackendHost.cs` | CuratorReview 增加 AI 合并逻辑 | ~60 |
| `Core/Bm25.cs` | 增加 ClusterSimilar 方法 | ~20 |

### 关键决策

**用什么模型做 Curator？** — 从 profiles 中选最便宜的，或加一个 `curator` profile 配置项。默认用当前活跃 profile。

**多久触发一次？** — 当前 14 天/200 条的提示保留。用户手动说「整理冷知识」或点界面按钮触发。不自动执行（涉及 LLM 调用成本）。

### 风险

中等。LLM 合并可能丢失细节。解决：原始条目只标记 `merged` 不删除，可以通过 `archive_search` 或者前端查看历史。

---

## P1: memory_add 加 write_approval

### 是什么

`memory_add` 当前是 AI 自主写入，不需要用户确认。借鉴 Hermes 的 `write_approval: true` 模式。

### 为什么是 P1

MEMORY.md 注入到每次对话的 system prompt。如果 AI 在幻觉状态下写了错误信息（"用户喜欢被叫老板"），所有后续对话都被污染。这是一次错误 → 永久影响的单点风险。

### 实现设计

```
方案 A（推荐）：分级确认
  - 普通 memory_add → 写入后前端弹 toast "AI 记录了：xxx [撤销]"
  - 涉及偏好/称呼的 → 必须用户确认后才写入（和 growth_record 一样）

方案 B：全局开关
  - 配置项 memory_write_approval: true/false
  - 和 Hermes 一致
```

### 改动范围

| 文件 | 改动 |
|------|------|
| `backend/BackendHost.cs` | memory_add 改为 PendingConfirmation 模式 |
| `electron/src/components/` | Toast 通知 + 撤销按钮 |

### 风险

低。实现简单，用户体验影响小（只是多一个确认）。

---

## P1: 子 Agent fork 模式

### 是什么

当前 `delegate_agent` 子 Agent 始终从空白上下文开始（只有任务描述+工作区路径）。借鉴 Codex 的 `FullHistory / FreshStart / Default` 三种模式。

### 为什么是 P1

场景问题：
- 用户说"帮我 review 一下刚才的改动" → 子 Agent 不知道刚才改了什么（空白上下文）
- 用户说"用 Claude 帮我重构这个模块" → 子 Agent 需要知道当前代码状态

当前只能靠主 Agent 手动把上下文塞进 `task` 参数，低效且容易遗漏。

### 实现设计

```
delegate_agent 新参数:
  forkMode: "fresh" | "summary" | "full"

fresh（默认，当前行为）:
  空白上下文，只有 task + workspace

summary:
  主 Agent 先调 CompactionPrompt 压缩当前上下文
  子 Agent 收到压缩摘要 + task
  Token 成本：~500-1000

full:
  子 Agent 收到完整对话历史（不含 system messages）
  Token 成本：可能很大，仅用于短对话
```

### 改动范围

| 文件 | 改动 |
|------|------|
| `backend/BackendHost.cs` | DelegateAgentAsync 增加 forkMode 逻辑 |
| `backend/BackendHost.cs` | BuildToolsSchema 更新 delegate_agent 参数 |

### 风险

低。新参数可选，默认 fresh 保持向后兼容。

---

## P1: ToolExposure 延迟加载

### 是什么

当前 32 个工具全部在 system prompt 里声明，占用大量上下文。借鉴 Codex 的 `Direct / Deferred / Hidden` 三级曝光。

### 为什么是 P1

32 个工具 × 每个 ~200 字符 = ~6400 字符 ≈ **2K tokens** 花在工具定义上。大部分对话只用到 5-8 个工具。尤其是 `file_write_excel`、`file_read_docx`、`reformat_md` 等低频工具，完全可以延迟曝光。

### 实现设计

```
Direct（默认）: 始终在 schema 中
Deferred: 初始隐藏，AI 可通过 tool_search 按需发现
Hidden: 永远不曝光（内部工具）

建议分类:
  Direct (15个): file_read/write/append/replace/list/find/tree/move/delete/batch
                 web_search/fetch/cached + now_time/random_int
  Deferred (10个): file_read_excel/write_excel/docx/read_docx/write_docx
                   reformat_md/open_url/open_path
                   tool_output_lookup/archive_search
  Hidden (3个): memory_add/remove/lesson_capture
                 (AI 通过反思 prompt 才知道要用，不需要在工具列表)

新增工具:
  tool_search(query) → 返回匹配的 Deferred 工具列表
```

### 改动范围

| 文件 | 改动 |
|------|------|
| `Cats/Cats.cs` | Cat 类增加 Exposure 枚举 |
| `Cats/CatRegistry.cs` | SchemasJson 支持过滤 Direct/All |
| `backend/BackendHost.cs` | BuildToolsSchema 传入 exposure 级别 |

### 风险

低。AI 在一轮对话中可以先搜工具再调用，和现在行为一致只是多一步。

---

## P2: Skill 生命周期管理

### 是什么

借鉴 Hermes 的 `active → stale → archive` 状态机，自动清理长期不用的 Skill。

### 实现设计

```
RanParty/skills/.usage.json → 记录每个 skill 的 last_used
30 天未使用 → 标记 stale（注入时显示 [不活跃]）
90 天未使用 → 移入 skills/.archive/（不再注入）
用户手动 pin → 跳过自动清理
```

---

## P2: ToolDispatchTrace 审计

### 是什么

每次工具调用生成结构化 trace：`{tool, args, result, durationMs, success}`，可回放可分析。

### 为什么是 P2

当前只在 `tool.completed` 事件里有 durationMs。没有持久化、没有聚合分析。有了完整 trace 后可以：
- 看哪个工具最慢
- 看哪个工具失败率最高
- 离线回放调试

### 实现设计

```
新增: RanParty/.trace/ 目录
每次工具调用 → 写入 {sessionId}_{timestamp}.jsonl
格式: {"ts":"...","tool":"...","args":"...","result_summary":"...","durationMs":123,"error":false}

定期清理: 超过 1000 个文件 → 合并为 .trace/archive/{month}.jsonl
```

---

## P3: 沙箱升级 + VFS trait

### 是什么

借鉴 Codex 的 `Unsandboxed → Seatbelt → Windows AppContainer` 沙箱升级，以及 `ExecutorFileSystem` trait 统一文件访问。

### 为什么是 P3

架构改动大。当前 Job Object 对单进程桌面应用场景足够。涉及的文件操作也可以用白名单兜底。长期演进方向，但不是近期优先级。

---

## 四档实现路线图

```
P0 (本周可做):
  Pre/Post Tool Hooks      ← 40 行新文件 + 10 行改动

P1 (下个迭代 1-2 周):
  LLM Curator 合并          ← 60 行改动
  memory_add 确认机制        ← 30 行 + 前端 toast
  子 Agent fork 模式         ← 40 行改动
  ToolExposure 延迟加载      ← 60 行改动

P2 (月度):
  Skill 生命周期              ← 100 行新文件
  ToolDispatchTrace 审计      ← 80 行

P3 (季度):
  AppContainer 沙箱          ← 架构级
  VFS trait                  ← 架构级
```
