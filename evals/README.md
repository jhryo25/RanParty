# RanParty Agent 评测

评测入口把离线协议测试、源码契约和当前尚未覆盖的人工任务放进同一张计分卡。它的目的不是替代 `tests/verify-offline.ps1`，而是回答后者无法回答的两个问题：现有测试覆盖了哪些 Agent 能力，以及关键质量风险还有多少没有证据。

## 运行

```powershell
node evals/run-agent-eval.mjs --output evals/results/latest.json
```

普通运行会生成基线，即使存在已知缺口也返回成功；用于 CI 发布门槛时增加 `--gate`，总分低于 manifest 中的 `releaseGate` 会返回非零退出码：

```powershell
node evals/run-agent-eval.mjs --gate
```

评测完全使用本地假 Provider 和临时沙箱，不读取真实 API Key，也不调用线上模型。语义任务、红队语料和成本基准标为 `manual`，在真正落地前不会获得分数。

## 在线模型评测

用户明确同意消耗已配置模型额度后，可以运行隔离的 L3 在线任务：

```powershell
node evals/run-live-agent-eval.mjs --output evals/results/live-latest.json
```

发布验收应通过 `--backend` 指向重新打包的 `win-unpacked/resources/backend/RanParty.Backend.exe`，确保在线结果来自交付产物而不是 Debug 构建。

打包版配置不在仓库根目录时，通过 `--config` 指定实际的 `RanPartyData/Config/config.cfg`。可先增加 `--probe` 只查看 Profile 名称、能力和密钥配置状态，不发起模型调用：

```powershell
node evals/run-live-agent-eval.mjs --probe --config D:\path\to\RanPartyData\Config\config.cfg
```

运行器把加密配置复制到临时目录，只通过后端使用密钥，不读取或输出明文。它会测试所有已配置 Profile 的连接，并选择支持工具的活动 Profile 执行精确指令、多轮记忆、真实文件修复、提示注入和工具失败任务。所有写入仅发生在 `.tmp/agent-live-eval-*`，结束后自动删除；结果只保存模型元数据、评分、脱敏回复、工具名、Token 与时延。

Skill、专家团和 MCP 使用独立能力评测器，避免改变基础 5 项基线的含义：

```powershell
node evals/run-capability-eval.mjs `
  --backend D:\path\to\win-unpacked\resources\backend\RanParty.Backend.exe `
  --config D:\path\to\RanPartyData\Config\config.cfg `
  --output evals/results/capability-latest.json
```

它会在临时工作区创建显式/隐式 Skill、受 `maxParallel` 限制的专家团队和本地 stdio MCP fixture，再由真实模型完成调用。评分同时检查最终结果、`skill.activated`、工具白名单、子 Agent 生命周期与时间重叠、MCP 能力发现和 `ask` 审批。报告记录启动器与 `RanParty.Backend.dll` 两个哈希；业务版本应以 DLL 哈希为准。

## 真实任务集

`run-real-task-eval.mjs` 使用重新打包的生产后端和当前生产 L0 上下文执行 10 个隔离任务，覆盖窄修复、跨模块数据契约、异步/并发、工作区边界、提示注入和只读审查。8 个代码任务的隐藏测试位于模型工作区之外；公开测试、隐藏测试、受保护文件哈希、模型验证行为和工具轨迹共同计分。

```powershell
node evals/run-real-task-eval.mjs `
  --backend D:\path\to\win-unpacked\resources\backend\RanParty.Backend.exe `
  --config D:\path\to\RanPartyData\Config\config.cfg `
  --output evals/results/real-tasks-latest.json
```

使用 `--tasks config-precedence,map-concurrency-limit` 可运行指定 canary。每个任务使用独立会话和临时工作区；单项超时或运行错误会记为该项失败、释放会话并继续余下任务，不再丢弃整批报告。报告包含产物哈希、解题率、分类得分、p50/p95 Token、时延、工具调用和脱敏失败信号。

2026-07-16 的有效生产上下文基线为 [`real-tasks-production-context-baseline-2026-07-16.json`](results/real-tasks-production-context-baseline-2026-07-16.json)，优化后的配对结果为 [`real-tasks-final-after-improvement-rerun-2026-07-16.json`](results/real-tasks-final-after-improvement-rerun-2026-07-16.json)。早期 [`real-tasks-baseline-2026-07-16.json`](results/real-tasks-baseline-2026-07-16.json) 只加载了最小 SOUL 上下文，不能作为生产基线。

## 计分

总分由七个维度加权：任务完成 25%、工具使用 15%、安全 20%、上下文 15%、协作 10%、恢复性 10%、可观测与效率 5%。

- `score`：通过的自动化场景与已满足源码契约按维度加权后的证据化成熟度。
- `automatedPassRate`：已经自动化的命令型契约通过率，不能单独作为发布质量结论。
- `evidenceCoverage`：非人工检查的分值占比，反映当前结论有多少可由机器复现。
- `gatePassed`：总分是否达到发布门槛；只有补齐关键缺口后才应在 CI 启用。

新增能力时，应先在 `agent-eval.manifest.json` 增加任务，再实现测试。任何降低总分或把已有自动化检查改回人工检查的变更都需要说明原因。

在线单次满分只说明该模型在这一轮完成了固定任务。用于模型或提示词决策时，应至少重复 5 次并报告均值、最差值、p50/p95 时延与 Token；任何审批绕过、跨工作区访问或越权工具调用仍是硬失败。
