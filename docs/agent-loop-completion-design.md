# RanParty Agent Loop 完成率改进设计

> 更新日期：2026-07-13。本文是当前 loop 行为的权威基线；外部项目结论以文末官方源码和官方文档为准。

## 目标

RanParty 的 loop 需要同时满足四件事：

1. 能持续执行长任务，但不会因为变化参数的工具调用无限运行。
2. 模型声称完成时，关键修改已经有读取、测试或构建证据。
3. 上下文压缩后不丢失当前工作状态、最新用户指令和工具调用配对。
4. 预算耗尽或 Provider 失败时，向用户返回可用的部分结果，而不是无声停止。

## 现状诊断

本轮修改前，`RoundTripAsync` 采用递归模型调用。它已经具备 API 重试、相同工具签名拦截、并行安全工具批处理和按原顺序写回结果，但有三个直接影响完成率的问题：

- 不同参数可以绕过重复签名保护，主 loop 和子 Agent 没有可靠的全局迭代上限。
- 原生文件工具写入后，模型可以不读取结果、不运行测试就直接结束。
- 压缩会排除全部历史，只保留单个摘要；摘要中的旧任务状态可能覆盖最新用户指令。

## Codex 设计要点

Codex 把一次任务、一次 turn 和单次模型/工具往返区分为显式生命周期：

- `RegularTask` 循环调用 `run_turn`，并在存在 pending input 时继续，同一活跃 turn 支持 steer 和 cancellation。
- `run_turn` 根据模型输出、工具 future 和新增用户输入决定是否需要 follow-up，而不是依靠无界递归。
- 上下文压力达到阈值且仍需继续时执行 mid-turn compaction；压缩有独立事件、触发原因和 hook 生命周期。
- token/rollout budget 是显式状态；预算压力和耗尽可以形成可观测终态。
- 工具调用和结果按协议项目保存，终止、打断、压缩和恢复都能保持 turn 关联。

对 RanParty 最有价值的不是照搬 Rust 结构，而是显式化 `running -> waiting_tool -> verifying -> finalizing -> completed/partial/failed` 状态，并让 UI、日志和持久化共享同一终态。

## Hermes 设计要点

Hermes 的官方 Agent Loop 文档和实现强调可配置的硬预算与压缩保护：

- 主 loop 默认 90 次迭代；子 Agent 有独立预算，默认上限 50。
- 预算使用达到约 70% 和 90% 时向模型注入压力提示，耗尽后做无工具总结。
- Provider 失败支持重试、凭据刷新和 fallback provider。
- 压缩前先刷新持久记忆，摘要中间历史，并保留最近 N 条原始消息（默认 20）。
- assistant tool call 与对应 tool result 保持成组，避免压缩后出现悬空工具调用。
- 会话增量持久化，长任务即使中断也保留可恢复状态。

这套设计的关键价值是“硬上限前主动收敛”和“压缩不牺牲最新工作集”。

## 本轮已落地

### 1. 有界主 loop 和子 Agent

- 主模型最多 48 个可使用工具的模型轮次。
- 单个用户 turn 最多接受 96 个工具调用；同一响应中超过上限的调用也会被拒绝。
- 子 Agent 最多 32 个工具轮次。
- 达到 70% 和 90% 预算压力时各注入一次收敛提示。
- 达到硬上限后关闭工具，允许一次最终归纳，并要求明确未完成或未验证项。
- 原有相同工具签名三次拦截继续保留，作为更早的局部保护。

### 2. 修改后验证门槛

- 成功执行 `file_write`、`file_append`、`file_replace`、Office 写入、移动、删除、批量写入或 Markdown 重排后，turn 标记为待验证。
- 成功执行文件回读/查找，或命令中包含 test/build/check/lint/typecheck/status/diff 等验证动作后，清除待验证状态。
- 模型在仍待验证时首次尝试结束，RanParty 注入一次内部验证提示并继续 loop。
- 验证提示仅对当前 turn 生效，结束后从后续上下文排除。

### 3. 压缩保留活动尾部

- 只摘要旧段，保留最近 2 到 12 条原始消息。
- 若保留边界落在 tool result 中间，向前扩展到对应 assistant tool-call 消息。
- 摘要明确标记为“背景、仅供参考”，最新未压缩用户指令优先。
- 二次压缩仍会合并旧摘要，并继续保留最新活动尾部。

### 4. 专家目录完成率修复

- `experts.skillhub.list` 按 `total` 自动读取全部分页，而不是固定第一页 60 条。
- 专家页默认显示 SkillHub 专家包目录，本地单专家放在独立标签中。
- 2026-07-13 在线验收：SkillHub `total=68`，RanParty 返回 68 个专家包。
- 在临时沙箱完整安装 `tech-test-automation`，成功校验并注册 6 个关联 Skills、团队 manifest、负责人和 installed 状态。
- 修复生成工作流 Skill 的安装 marker，使 `skillContentHash`、整树哈希、community 信任和 explicit-only 策略满足注册器完整性契约。

## 下一阶段

### P1：显式状态机和终态

将 `RoundTripAsync` 的递归改成迭代状态机，持久化以下字段：

- `iteration_count`、`tool_call_count`、`budget_level`
- `last_successful_action`、`last_error`、`verification_state`
- `terminal_status`: `completed | partial | cancelled | failed | budget_exhausted`

这样可以消除递归栈增长，并让断点恢复、遥测和 UI 状态一致。

### P1：证据账本

每个目标项维护 `requirement -> action -> evidence -> status`。最终答复前检查高风险项是否具备成功工具结果、文件哈希、测试退出码或外部响应。验证门槛从“发生过验证工具”提升为“验证证据覆盖具体修改”。

### P1：Provider fallback

把当前三次同 Provider 重试扩展为可配置 fallback profile。主模型失败后保留同一 turn 和工具历史，切换备用模型；压缩、视觉和最终归纳可配置独立低成本模型。

### P2：loop middleware

建立 `before_model`、`after_model`、`before_tool`、`after_tool`、`before_final` hook，逐步迁移审批、预算、重复检测、验证和审计逻辑，避免继续扩大 `BackendHost`。

### P2：更精确的命令验证分类

当前原生文件写工具可以可靠追踪；通过任意 Shell 命令修改文件仍只能启发式识别。后续应让 Shell 返回 `changed_paths`、`exit_code` 和 `verification_kind`，并由工作区快照或 Git diff 交叉验证。

## 指标与发布门槛

至少记录以下 turn 级指标：

| 指标 | 定义 | 首期门槛 |
|---|---|---|
| verified completion rate | 有修改的完成 turn 中，具备成功验证证据的比例 | >= 95% |
| budget exhaustion rate | 因硬预算进入 partial 的 turn 比例 | < 1% |
| duplicate block rate | 触发重复签名拦截的 turn 比例 | 持续下降 |
| compaction drift rate | 压缩后违反最新用户指令或重复已完成工作的比例 | < 0.5% |
| tool error recovery rate | 工具失败后最终完成或明确 partial 的比例 | >= 90% |
| silent termination rate | 无 completed/partial/failed 终态的 turn 比例 | 0 |

发布门槛：预算测试、重复调用测试、写后验证测试、压缩/二次压缩测试、子 Agent 测试和前端专家目录契约测试必须全部通过；在线专家目录测试应在发布前运行一次。

## 已知限制

- 当前流式协议可能已经向 UI 输出模型第一次“准备结束”的文本，随后验证门槛才要求继续；P1 状态机应增加 provisional assistant 状态，在验证通过前不提交最终消息。
- 48/96/32 目前是代码常量，后续应按模型、模式和任务类型配置，并设置合理上下界。
- 在线 SkillHub 总数会变化，测试以实时 API `total` 为准，不应写死 68。

## 官方来源

- SkillHub 专家包安装规范：<https://skillhub.cn/install/skillhub-pack-install.md>
- OpenAI Codex regular task：<https://github.com/openai/codex/blob/main/codex-rs/core/src/tasks/regular.rs>
- OpenAI Codex turn loop：<https://github.com/openai/codex/blob/main/codex-rs/core/src/session/turn.rs>
- OpenAI Codex compaction：<https://github.com/openai/codex/blob/main/codex-rs/core/src/compact.rs>
- OpenAI Codex rollout budget：<https://github.com/openai/codex/blob/main/codex-rs/core/src/session/rollout_budget.rs>
- Hermes Agent Loop 官方文档：<https://github.com/NousResearch/hermes-agent/blob/main/website/docs/developer-guide/agent-loop.md>
- Hermes iteration budget：<https://github.com/NousResearch/hermes-agent/blob/main/agent/iteration_budget.py>
- Hermes context compressor：<https://github.com/NousResearch/hermes-agent/blob/main/agent/context_compressor.py>
- Hermes conversation loop：<https://github.com/NousResearch/hermes-agent/blob/main/agent/conversation_loop.py>
