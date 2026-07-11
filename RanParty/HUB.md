# HUB.md — 会话上下文中枢

> **版本 1.2 | 2026-07-11**
> 本文档与 SOUL.md、AGENTS.md、TOOL.md 一起在每次会话首次对话时自动注入 system 消息。

---

## 注入机制

`EnsureL0()` 在会话首次发送时构建三层 system 上下文：

```
stable: 角色卡 + AGENTS.md + TOOL.md + HUB.md + 协作规则
context: 当前工作区 + 有界 Level-0 Skill 元数据
volatile: MEMORY.md + LESSONS.md + 搜索索引 + 角色成长记录
```

当工作区、角色、记忆或 Skill 注册表变化时，后端会使对应层失效并在安全时机重建。

---

## 知识组织结构

```
你的RanParty/
├── SOUL.md           ← 身份锚点 + 思考模式 + 情绪模块
├── AGENTS.md         ← 决策规则 + 运行红线 + 反问/计划规范
├── TOOL.md           ← 所有可用工具的详细操作指南
├── HUB.md            ← 本文件：目录索引 + 收工流程
│
├── skills/           ← Skill 注册目录（SkillRegistry 自动扫描）
│   ├── csharp/SKILL.md
│   ├── unity/SKILL.md
│   ├── godot/SKILL.md
│   └── ...           ← 每个子目录一个 SKILL.md
│
├── Characters/       ← 角色卡目录（按需选择，替换默认 SOUL.md）
│   ├── cat.md
│   ├── butler.md
│   ├── tutor.md
│   └── assistant.md
│
├── InstalledSkills/  ← SkillHub 市场安装的 Skill
│
├── Config/           ← 配置与会话持久化（由后端管理，不手动编辑）
├── CatTemp/          ← 草稿/缓存（收工后清理）
└── Log/              ← 运行日志
```

---

## Skill 系统

Skill 采用 Codex 式渐进披露，有两条调用路径：

1. **显式选择**：前端提交后端签发的 Skill ID，后端校验后读取根 `SKILL.md`，作为仅本轮有效的 transient context。
2. **按需激活**：Level-0 只提供有界的 `id/name/description/trust/version`；当任务与 description 明确匹配时，模型可调用 `skill_view(id)` 读取根文档，之后才能读取其引用资源。

内置、用户和工作区 Skill 可在策略允许时按需激活；Community/市场 Skill 永远只能显式选择。每次激活都发出 `skill.activated` 审计事件。`allowed-tools` 只能收窄工具集，不能授予新权限；脚本、Hook 和 MCP 不会因安装或激活而自动执行。

Skill 注册来源：
- `RanParty/skills/` — 内置
- `<workspace>/.agents/skills/` — 工作区
- `%USERPROFILE%\.agents\skills\` — 用户全局
- `RanParty/InstalledSkills/` — 经市场验证后安装
- LobsterAI/SkillHub 兼容目录 — 按策略标记信任级别

---

## 收工流程

1. 更新涉及的文件（版本号 +1）
2. 清理 CatTemp 中的草稿/中介文件
3. 如有重要结论，考虑沉淀为 Skill 或记录到对应项目文档

---

## 活跃项目

| 项目 | 阶段 | 说明 |
|------|------|------|
| （你的项目A） | — | — |
| （你的项目B） | — | — |

---

_版本 1.2 | 2026-07-11_
