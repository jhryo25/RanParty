# 工具循环安全边界 — RanParty vs Codex vs Hermes

> 2026-07-08

## 总览

| 安全机制 | RanParty | Codex | Hermes |
|---------|:--------:|:-----:|:------:|
| **深度限制** | 200 次递归 | 有（spawn depth tracking）| 无显式限制 |
| **调用上限** | 400 次/轮 | 无显式数字 | 无显式限制 |
| **重复检测** | ✅ 规范化签名，3 次拦截 | ✅ terminal outcome AtomicBool | ❌ 无 |
| **类别预算** | ✅ search/shell=10, write=20 | ❌ 无 | ❌ 无 |
| **输出保护** | ✅ Shell 65KB + 16K截断 | ✅ 截断+缓存 | ❌ 依赖 LLM 自觉 |

---

## 逐项对比

### 深度限制

| | RanParty | Codex | Hermes |
|---|---|---|---|
| 实现 | `depth < 200` 硬编码 | `spawn_depth` 递归深度追踪 | 无 |
| 触发后行为 | `ForceFinal = true`，注入提示让模型总结 | 拒绝 spawn，返回错误 | — |
| 适用场景 | 全部工具调用链 | 仅子 Agent 嵌套 | — |

**评价：** RanParty 最保守（200 层足够深但仍有上限），Codex 仅限制嵌套 spawn 不限制单 Agent 循环，Hermes 靠 LLM 自己停。

### 调用上限

| | RanParty | Codex | Hermes |
|---|---|---|---|
| 实现 | `TotalCalls > 400` 硬截断 | `terminal_outcome_reached` 信号 | 无 |
| 触发条件 | 累计 400 次 tool 消息 | 任意环节设置 AtomicBool | — |
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
| **核心假设** | 模型可能失控，需要硬限制 | 沙箱兜底，模型可信 | 用户是最终裁判 |
| **优势** | 最可预测，永不跑飞 | 灵活，正常场景不受限 | 零误杀，用户完全掌控 |
| **劣势** | 复杂任务可能被过早截断 | 需要完善的沙箱体系 | 依赖用户判断力 |
| **适用场景** | 本地 Agent，用户不在场 | 生产级 API，服务化 | 交互式 CLI，用户一直在线 |

---

## 建议

RanParty 的硬数字栅栏在**用户不在场时**是最安全的——Codex 的 sandbox 体系和 Hermes 的用户确认都无法弥补这个场景。但有两处可以借鉴 Codex 优化：

1. **`terminal_outcome` 信号**（P2）：替代部分硬数字上限。当模型明确表示"任务完成"时主动设置，减少过早截断
2. **类别预算可配置**（P2）：当前 search=10 对复杂调研任务可能不够，改成可配置参数
