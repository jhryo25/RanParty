# Codex / Hermes 对齐审查与修复记录

> 审查日期：2026-07-11。范围：后端工具循环、会话持久化、Electron 信任边界、用户交互竞态、Skill 渐进披露/安装和文档一致性。

## 已修复

- 会话：原子 JSON 持久化、损坏/超大文件隔离、删除竞态、消息幂等、新建并发送原子化。
- 工具循环：主/子 Agent 轮次和调用预算、重复签名、类别限额、严格 Provider SSE 终态、输入/输出/遍历上限。
- 并发：请求执行/排队上限，审批/反问/取消控制请求不被阻塞，profile 采用不可变运行时快照。
- 终态：事件序号在写锁内分配；旧 turn 不再覆盖新 turn；取消、审批和反问强制绑定 session/turn。
- 交互恢复：Bootstrap 返回 event cursor 和 pending approval/clarification，渲染器重载后可继续处理。
- Electron：导航、IPC sender/origin、方法和路径 allowlist；webview 权限/下载默认拒绝；HTTPS-only guest；严格 CSP；文件操作统一经后端授权。
- 用户交互：按会话草稿/队列，防重发锁，plan revision 门禁，Skill 选择失效收敛，市场请求 epoch 和结构化确认。
- Skill：有界 Level-0 元数据、deny-wins invocation policy、根文档先激活、`skill.activated` 审计、能力只收窄、Community explicit-only 且本地读取/网络再审批。
- Skill 安装：有界下载/解压/缓存，token + SHA-256 不可变预览，整树资源完整性校验，reparse/hardlink 拒绝，v2 journal 事务式安装/卸载/恢复。
- Skill 数据边界：缓存工具结果绑定 session/turn/来源工具及原参数；Community 即使在 auto 模式也不能绕过数据审批；本地市场按规范化来源身份安装，同名不同来源互不覆盖。
- 前端架构：`App.tsx` 313 行、`Composer.tsx` 226 行、`Transcript.tsx` 147 行、`types.ts` 496 行，均回到 `electron/AGENTS.md` 硬上限内。

## 验证

`tests/verify-offline.ps1` 统一运行：

- C# backend build：0 warning / 0 error。
- CoreRuntimeSmoke + SkillRegistrySmoke。
- Vitest：8 个文件，44 个用例。
- Electron 生产构建；主包约 468KB，设置与 Skill 广场已懒加载。
- 18 个离线进程级协议/竞态/能力冒烟测试。

## 明确保留的长期架构差距

以下不是本轮已完成能力，文档已改为真实状态：

- Shell Job Object 只限制生命周期和内存，不是 Codex 级 AppContainer/VFS 文件系统沙箱。
- 工具暴露已有 Direct/Deferred，尚无独立 Hidden 层。
- MCP 目前是配置/策略骨架，不是完整 stdio/http 调度运行时。
- Pre/Post tool hooks、完整调用回放、LLM Curator 和 Skill 生命周期仍属后续特性工程。
- `BackendHost` 仍是大型编排器；下一阶段应按 Session/Turn、Approval、SkillInstall、Profile 和 EventLog 边界拆分。

参考：[OpenAI Agent Skills](https://learn.chatgpt.com/en/articles/20001069-building-and-running-agent-skills)、[Codex 安全边界](https://openai.com/index/running-codex-safely/)、[Hermes 架构](https://hermes-agent.nousresearch.com/docs/developer-guide/architecture)、[Hermes Skills](https://hermes-agent.nousresearch.com/docs/user-guide/features/skills) 与 [Hermes 安全模型](https://hermes-agent.nousresearch.com/docs/user-guide/security/)。
