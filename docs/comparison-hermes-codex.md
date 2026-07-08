# RanParty vs Hermes vs Codex — 可借鉴特性对比

> ✅ 已实现  🔶 部分实现  ❌ 未实现  — 不适用

## 一、自进化与知识管理

| 特性 | Hermes | Codex | RanParty | 借鉴优先级 |
|------|:------:|:-----:|:--------:|:----------:|
| 热冷分离知识存储 | ✅ MEMORY/USER + archives | — | ✅ | — |
| BM25 冷归档检索 | ❌ 无（靠 file_read） | ❌ 无 | ✅ archive_search | — |
| 经验去重（BM25关键词重叠） | ❌ 无 | — | ✅ lesson_capture | — |
| 角色独立成长轨迹 | — | — | ✅ _growth.md | — |
| **LLM 驱动的 Curator 合并** | ✅ 每周合并重叠 skill → umbrella | — | 🔶 仅计数+标记 | P1 |
| **Skill write_approval 门控** | ✅ 写前需用户确认 | — | 🔶 growth_record 有/memory_add 无 | P1 |
| **Skill 生命周期管理** | ✅ active→stale→archive+pinned | — | 🔶 仅 hits 计数 | P2 |
| **学习图谱可视化** | ✅ Desktop UI 节点+关系 | — | 🔶 仅文件列表 | P2 |
| **Protected built-in skills** | ✅ "plan"不可curate | — | ❌ | P2 |
| **Hub 安装 Skill 免疫** | ✅ 外部 skill 永不修改 | — | 🔶 安装后等同内置 | P2 |

## 二、工具与安全

| 特性 | Hermes | Codex | RanParty | 借鉴优先级 |
|------|:------:|:-----:|:--------:|:----------:|
| **Pre/Post Tool Hooks** | ❌ | ✅ 输入重写+输出处理 | ❌ | P0 |
| 工具参数 Schema 校验 | — | ✅ JSON Schema | ✅ ValidateArgs | — |
| 错误分类枚举 | ❌ | ✅ Fatal/RespondToModel/Recoverable | ✅ ErrorKind 6值 | — |
| 并行工具执行 | — | ✅ RwLock gate | ✅ Task.WhenAll | — |
| **ToolExposure 延迟加载** | — | ✅ Direct/Deferred/Hidden | ❌ 所有工具始终可见 | P1 |
| **ToolDispatchTrace 审计轨迹** | — | ✅ 逐工具计时+回放 | 🔶 tool.completed 有 durationMs | P2 |
| **沙箱升级链路** | — | ✅ Unsandboxed→AppContainer | ❌ 仅 Job Object | P2 |
| **网络代理+拒绝令牌** | — | ✅ proxy+denial tokens | ❌ 仅 IP 范围检查 | P3 |
| **VFS trait 文件访问** | — | ✅ 所有 FS 走 trait | ❌ 直接 File.* 调用 | P3 |
| MCP 工具连接器 | — | ✅ | — | — |

## 三、Agent 协作

| 特性 | Hermes | Codex | RanParty | 借鉴优先级 |
|------|:------:|:-----:|:--------:|:----------:|
| **子 Agent fork 模式** | — | ✅ FullHistory/FreshStart/Default | ❌ 无 fork 模式 | P1 |
| **Terminal outcome 追踪** | — | ✅ AtomicBool 终止信号 | 🔶 ForceFinal 较简单 | P2 |
| **审批缓存 (ApprovalKey)** | — | ✅ 会话级去重 | 🔶 IsSessionAllowed | P2 |
| Cron job 引用自动重写 | ✅ 合并时更新引用 | — | — | — |

## 四、种子数据与文档

| 特性 | Hermes | Codex | RanParty | 状态 |
|------|:------:|:-----:|:--------:|:----:|
| 角色卡与 AGENTS/TOOL 职责分离 | — | — | ✅ 已拆分 | ✅ |
| 文档与代码一致性 | — | — | ✅ 已对齐 | ✅ |
| Skill 市场兼容 | — | ✅ SkillHub CLI 兼容 | ✅ 已实现 | ✅ |

---

## 建议实现优先级

| 优先级 | 特性 | 来源 | 理由 |
|--------|------|------|------|
| **P0** | Pre/Post Tool Hooks | Codex | 打开扩展点：输出校验、日志注入、审批拦截都可基于此 |
| **P1** | LLM 驱动 Curator 合并 | Hermes | 冷归档无限增长时必须智能压缩，当前 curator 只计数不合并 |
| **P1** | memory_add 加 write_approval | Hermes | 防止 AI 自作主张记错误信息 |
| **P1** | 子 Agent fork 模式 | Codex | 子 Agent 可以选择继承父上下文，而不是每次都空白 |
| **P1** | ToolExposure 延迟加载 | Codex | 工具面太大(32个)会挤占上下文窗口 |
| **P2** | Skill 生命周期 (stale→archive) | Hermes | 长期运行后需要自动清理 |
| **P2** | 沙箱升级链路 | Codex | Windows AppContainer 比 Job Object 更安全 |
| **P2** | ToolDispatchTrace 审计 | Codex | 调试和回放用 |
| **P3** | VFS trait / 网络代理 | Codex | 架构改动大，长期演进 |
