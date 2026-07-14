# 工具循环安全边界 — RanParty vs Codex vs Hermes

> 本文保留为 2026-07-11 的历史审查记录，其中部分数字和外部项目结论已过时。当前权威基线见 [agent-loop-completion-design.md](./agent-loop-completion-design.md)。

> 2026-07-11；数字以当前实现为准。对 Codex/Hermes 的结论需绑定具体 commit/tag 后才能作为长期基线。

## 总览

| 安全机制 | RanParty | Codex | Hermes |
|---------|:--------:|:-----:|:------:|
| **主循环上限** | 80 次模型往返 | 有终止状态 | 无统一数字 |
| **工具调用上限** | 160 次/轮 | 依实现版本 | 无统一数字 |
| **子 Agent 上限** | 深度 3、10 轮、40 次工具 | spawn depth tracking | 依实现版本 |
| **重复检测** | ✅ 规范化签名，3 次拦截 | ✅ terminal outcome AtomicBool | ❌ 无 |
| **类别预算** | ✅ search/shell=10, write=20 | ❌ 无 | ❌ 无 |
| **输出保护** | ✅ Shell 65KB + 16K截断 | ✅ 截断+缓存 | ❌ 依赖 LLM 自觉 |

---

## 逐项对比

### 主循环与子 Agent 限制

| | RanParty | Codex | Hermes |
|---|---|---|---|
| 实现 | 主模型最多 80 轮；子 Agent 深度 3、循环 10 | `spawn_depth` 递归深度追踪 | 依版本 |
| 触发后行为 | 禁止后续工具并要求 final-only 收束 | 拒绝 spawn/进入终止流程 | — |
| 适用场景 | 主模型工具循环 + 子 Agent | 子 Agent/运行时 | — |

**评价：** 硬上限使最坏资源消耗可预测，但不等价于 OS 沙箱，也可能提前截断合法长任务。

### 调用上限

| | RanParty | Codex | Hermes |
|---|---|---|---|
| 实现 | `MaxToolCallsPerRun = 160` | 终止状态/运行时策略 | 依版本 |
| 触发条件 | 单轮累计 160 次 tool call | 依当前实现 | — |
| 优雅降级 | 注入 "已达到安全上限" prompt | 后续工具调用直接跳过 | — |

**评价：** RanParty 的硬数字更可预测但可能过早截断。Codex 的信号机制更灵活——只有真正陷入循环才终止，正常多工具调用不受限。Hermes 完全依赖审批门控和超时兜底。

### 重复检测

| | RanParty | Codex | Hermes |
|---|---|---|---|
| 实现 | `NormalizeJson(args)` 生成签名 | 无专项重复检测 | 无 |
| 阈值 | 3 次相同签名 | — | — |
| 绕过风险 | 交替调用可绕过（已用类别预算弥补） | 依赖 terminal_outcome | — |

**评价：** RanParty 的规范化签名是三者中最精细的重复检测。Codex 没有显式去重——它信任 terminal_outcome 机制。Hermes 无此机制。

### 类别预算（RanParty 独有）

Codex 和 Hermes 都没有这个概念。RanParty 创新性地将工具分组并设预算：
- `search`: web_search/cached/fetch/cached ≤ 10
- `shell`: shell_run/ps_run ≤ 10
- `file_write`: write/append/replace/move/delete/excel/docx/batch ≤ 20

**评价：** 这是 RanParty 独有的防御层，防止"交替调用绕过重复检测"。Codex 采用不同思路：把问题交给 `terminal_outcome` 信号机制处理。

### 输出保护

| | RanParty | Codex | Hermes |
|---|---|---|---|
| Shell 输出 | 流式读取 65KB 上限 | 沙箱级截断 | 无专项 |
| 工具结果 | 16K 字符截断 + cache_id 回溯 | `DEFAULT_OUTPUT_BYTES_CAP` 截断 | 无 |
| 截断策略 | head(2/3) + tail(1/3) | 按字节截断 | — |

**评价：** RanParty 和 Codex 都有输出保护，策略相似。Hermes 无此机制。

---

## 设计哲学差异

| | RanParty | Codex | Hermes |
|---|---|---|---|
| **防御风格** | 多层硬数字栅栏 | 信号机制 + 沙箱 | 审批门控 + 用户确认 |
| **核心假设** | 模型可能失控，需要硬限制 | 运行时策略 + OS 沙箱分层兜底 | 审批和交互流程为重要边界 |
| **优势** | 最可预测，永不跑飞 | 灵活，正常场景不受限 | 零误杀，用户完全掌控 |
| **劣势** | 复杂任务可能被过早截断 | 需要完善的沙箱体系 | 依赖用户判断力 |
| **适用场景** | 本地 Agent，需明确审批高风险操作 | 需要强 OS 隔离的 Agent 运行时 | 交互式 Agent 工作流 |

---

## 建议

RanParty 的硬数字栅栏是资源上限，不是安全级别证明。当前 Shell 只有 Job Object 进程约束，没有 AppContainer/VFS 文件系统隔离，因此不应声称它比 Codex 沙箱更安全。后续可优化：

1. **`terminal_outcome` 信号**（P2）：替代部分硬数字上限。当模型明确表示"任务完成"时主动设置，减少过早截断
2. **类别预算可配置**（P2）：当前 search=10 对复杂调研任务可能不够，改成可配置参数
