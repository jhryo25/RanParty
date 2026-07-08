# RanParty 知识库种子

这个目录是 RanParty 首次启动时使用的知识库与角色种子数据。它不是桌面客户端源码，而是给 AI Agent 注入人格、规则、工具说明、技能和知识管理入口的内容层。

## 目录作用

RanParty 的桌面客户端负责会话、模型、工具调用和文件操作；本目录提供默认知识体系：

- `SOUL.md`：默认角色卡和行为风格。
- `AGENTS.md`：运行红线、安全约束和协作规则。
- `TOOL.md`：工具使用说明。
- `HUB.md`：知识管理与 Skill 维护入口。
- `Characters/`：角色卡目录，包含可选专家人格。
- `skills/`：标准 `目录/SKILL.md` 格式技能示例。
- `InstalledSkills/`：从 Skill 广场或 SkillHub 安装的本地 Skill。
- `Config/`：配置与会话持久化，由后端管理。
- `CatTemp/`：草稿/缓存，收工后可清理。
- `Log/`：运行日志。

## 角色卡注入

角色卡在 RanParty 中是互斥注入的会话上下文：

- 选择 `SOUL.md` 时，只注入 `SOUL.md`。
- 选择其他角色卡时，只注入对应角色卡。
- 不会把 `SOUL.md` 和其他角色卡叠加注入。

这样可以避免角色设定冲突，也方便为不同模型配置绑定不同专家身份。

## Skill 规范

新技能建议使用标准结构：

```text
skills/
└─ example-skill/
   └─ SKILL.md
```

`SKILL.md` 建议包含：

```markdown
---
name: example-skill
description: 这个技能适用的场景
---

# 使用说明

告诉 AI 什么时候使用、怎么使用、有哪些边界。
```

RanParty 会先扫描并展示 `name` 和 `description`；只有用户显式选择后，后端才读取完整 `SKILL.md` 并注入下一次发送。

## 知识管理约定

- 用户画像、经验教训、冷归档和角色成长由“知识管理”页统一查看。
- 角色成长写入 `Characters/{角色名}_growth.md`。
- 可复用能力应沉淀为 `skills/<name>/SKILL.md`。
- 临时分析产物写入当前工作区，不再使用旧版分层归档路由。

## 注意事项

- 本目录会被打包进桌面版作为 seed data。
- 便携版首次启动后，会把可编辑副本写入程序旁的 `RanPartyData/`。
- 如果用户已经有本地数据，更新 seed data 不会强制覆盖用户会话、配置和已安装 Skill。
- 不要在本目录提交真实 API Key、个人隐私、未脱敏客户数据或无法公开的项目资料。

更多客户端信息见仓库根目录 [README.md](../README.md)。
