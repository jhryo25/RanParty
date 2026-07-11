# RanParty vs Hermes vs Codex — 可借鉴特性对比

> 2026-07-11 实施状态。✅ 已实现  🔶 部分实现  ❌ 未实现  — 不适用。外部架构结论应绑定具体 commit/tag 后再用于决策。

## 一、自进化与知识管理

| 特性 | Hermes | Codex | RanParty | 借鉴优先级 |
|------|:------:|:-----:|:--------:|:----------:|
| 热冷分离知识存储 | ✅ MEMORY/USER + archives | — | ✅ | — |
| BM25 冷归档检索 | ❌ 无（靠 file_read） | ❌ 无 | ✅ archive_search | — |
| 经验去重（BM25关键词重叠） | ❌ 无 | — | ✅ lesson_capture | — |
| 角色独立成长轨迹 | — | — | ✅ _growth.md | — |
| **LLM 驱动的 Curator 合并** | ✅ 每周合并重叠 skill → umbrella | — | 🔶 仅计数+标记 | P1 |
| **Skill write_approval 门控** | ✅ 写前需用户确认 | — | ✅ memory/growth/curator 写入均审批 | — |
| **Skill 生命周期管理** | ✅ active→stale→archive+pinned | — | 🔶 仅 hits 计数 | P2 |
| **学习图谱可视化** | ✅ Desktop UI 节点+关系 | — | 🔶 仅文件列表 | P2 |
| **Protected built-in skills** | ✅ "plan"不可curate | — | 🔶 已分 trust/scope，尚无 curator 保护规则 | P2 |
| **Hub 安装 Skill 免疫** | ✅ 外部 skill 永不修改 | — | ✅ community explicit-only + 事务安装校验 | — |

## 二、工具与安全

| 特性 | Hermes | Codex | RanParty | 借鉴优先级 |
|------|:------:|:-----:|:--------:|:----------:|
| **Pre/Post Tool Hooks** | ❌ | ✅ 输入重写+输出处理 | ❌ | P0 |
| 工具参数 Schema 校验 | — | ✅ JSON Schema | ✅ ValidateArgs | — |
| 错误分类枚举 | ❌ | ✅ Fatal/RespondToModel/Recoverable | ✅ ErrorKind 6值 | — |
| 并行工具执行 | — | ✅ RwLock gate | ✅ Task.WhenAll | — |
| **ToolExposure 延迟加载** | — | ✅ Direct/Deferred/Hidden | 🔶 Direct/Deferred + tool_search，尚无 Hidden 层 | P1 |
| **ToolDispatchTrace 审计轨迹** | — | ✅ 逐工具计时+回放 | 🔶 `.tool_audit.jsonl` 持久摘要，无完整参数/结果回放 | P2 |
| **沙箱升级链路** | — | ✅ Unsandboxed→AppContainer | ❌ 仅 Job Object | P2 |
| **网络代理+拒绝令牌** | — | ✅ proxy+denial tokens | ❌ 仅 IP 范围检查 | P3 |
| **VFS trait 文件访问** | — | ✅ 所有 FS 走 trait | ❌ 直接 File.* 调用 | P3 |
| MCP 工具连接器 | — | ✅ | 🔶 配置/策略骨架，未实现完整传输 | P2 |

## 三、Agent 协作

| 特性 | Hermes | Codex | RanParty | 借鉴优先级 |
|------|:------:|:-----:|:--------:|:----------:|
| **子 Agent fork 模式** | — | ✅ FullHistory/FreshStart/Default | ✅ fresh/summary/full + toolsMode | — |
| **Terminal outcome 追踪** | — | ✅ AtomicBool 终止信号 | 🔶 ForceFinal 较简单 | P2 |
| **审批缓存 (ApprovalKey)** | — | ✅ 会话级去重 | ✅ 规范化参数 + workdir + policy version | — |
| Cron job 引用自动重写 | ✅ 合并时更新引用 | — | — | — |

## 四、种子数据与文档

| 特性 | Hermes | Codex | RanParty | 状态 |
|------|:------:|:-----:|:--------:|:----:|
| 角色卡与 AGENTS/TOOL 职责分离 | — | — | ✅ 已拆分 | ✅ |
| 文档与代码一致性 | — | — | ✅ 已对齐 | ✅ |
| Skill 市场兼容 | — | ✅ Plugin marketplace / `.codex-plugin` | ✅ Codex Plugin 目录 + SkillHub 附加源 | ✅ |

---

## 建议实现优先级

| 优先级 | 特性 | 来源 | 理由 |
|--------|------|------|------|
| **P0** | Pre/Post Tool Hooks | Codex | 打开扩展点：输出校验、日志注入、审批拦截都可基于此 |
| **P1** | LLM 驱动 Curator 合并 | Hermes | 冷归档无限增长时必须智能压缩，当前 curator 只计数不合并 |
| **已完成** | memory 写审批、子 Agent fork、Direct/Deferred 暴露 | Hermes/Codex | 已有契约测试；Hidden 暴露仍待实现 |
| **P2** | Skill 生命周期 (stale→archive) | Hermes | 长期运行后需要自动清理 |
| **P2** | 沙箱升级链路 | Codex | Windows AppContainer 比 Job Object 更安全 |
| **P2** | ToolDispatchTrace 审计 | Codex | 调试和回放用 |
| **P3** | VFS trait / 网络代理 | Codex | 架构改动大，长期演进 |
