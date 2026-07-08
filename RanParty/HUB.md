# HUB.md — 会话上下文中枢

> **版本 1.1 | 2026-07-08**
> 本文档与 SOUL.md、AGENTS.md、TOOL.md 一起在每次会话首次对话时自动注入 system 消息。

---

## 注入机制

`EnsureL0()` 将以下 4 个文件拼接为一个 system 消息，在会话首次发送时注入：

```
角色卡 (SOUL.md 或 Characters/{name}.md)
  + AGENTS.md
  + TOOL.md
  + HUB.md (本文件)
  + [当前会话工作区] + [协作规则]
```

四个文件没有独立的加载时机——它们是**一次性全部注入**的。

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

Skill 通过**前端选择器显式选择**，并非关键词自动加载。流程：

1. 用户在输入框选择 Skill → 前端提交 Skill ID
2. 后端 `SkillRegistry.FindById()` 校验 ID
3. 读取对应 `SKILL.md` 完整内容
4. 注入到**本次请求**的 system 消息中
5. 请求完成后自动清除

Skill 注册来源：
- `RanParty/skills/` — 内置和已安装
- `%USERPROFILE%\.agents\skills\` — 用户全局

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

_版本 1.1 | 2026-07-08_
