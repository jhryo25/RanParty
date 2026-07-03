# RanParty 知识框架

> 四阶六类知识管理体系 · DearParty 多智能体操作系统

---

## 这是什么？

RanParty 是一套**知识管理框架**，将 AI 助手的记忆分为四个层级、六种类型，让知识从「对话历史」变成「可积累、可检索、可迁移」的结构化资产。

搭配 **DearParty**（C# 原生多智能体操作系统），你可以：
- 用自然语言对话让 AI 读写文件、操作 Excel/Word
- 用四阶六类框架沉淀你的项目知识和经验
- 通过 WinForms 桌面窗口获得流畅的 AI 对话体验

---

## 四阶六类架构

```
L0 — 指令集（每次会话自动嵌入）
├── 身份锚点      ← 定义 AI 的人格与行为规则
├── 运行红线      ← 不可违反的安全约束
└── 工具指南      ← 所有可用工具的操作手册

L1 — 中枢
└── 路由枢纽      ← 目录树 + 版本管理 + 知识生命周期

L2 — 能力层（按需加载）
├── Skill/        ← 持久技能：编码约定、架构模式、领域知识
└── Exp/          ← 工具经验：引擎使用、脚本铁律、部署踩坑

L3 — 记忆层（定点检索）
├── index/        ← 百科级静态知识，增量覆写
├── project/      ← 当前项目追踪，动态更新
└── history/      ← 项目闭包归档，只写不改
```

---

## 快速开始

### 1. 获取 DearParty

获取 DearParty 最新版本。

### 2. 阅读中枢

→ `HUB.md` — 知识网络中控枢纽。**这里是整个框架的操作手册**：如何新建 Skill、如何追踪项目、如何收工沉淀、版本号怎么升。

### 3. 了解 L0 指令集

→ `SOUL.md` — AI 身份锚点、思考模式、决策规则。**你可直接修改此文件来定制 AI 性格。**
→ `AGENTS.md` — 不可违反的运行红线。
→ `TOOL.md` — 18 个工具的完整操作指南。

### 4. 阅读 DearParty 使用指南

→ `L2/Exp/DearParty.md` — 含新手教程、启动步骤、配置说明、工具清单。

### 5. 参考技能

→ `L2/Skill/CSharp.md` — Static C 风格编码约定。
→ `L2/Skill/AVGEngine.md` — AVG 剧本引擎通用架构。
→ `L2/Skill/DM_Physics.md` — 战斗物理体系设计。
→ `L2/Skill/Wisdom.md` — 元认知框架。
→ `L2/Exp/` — Unity/Godot/Windows 脚本/SearxNG 经验。
## 目录结构

```
RanParty/
├── README.md                 ← 你在这里
├── SOUL.md                   ← AI 身份锚点 + 思考模式（可定制）
├── AGENTS.md                 ← 运行红线
├── TOOL.md                   ← 工具操作指南（18 工具）
├── HUB.md                    ← 知识网络中控枢纽 ⭐
│
├── L2/
│   ├── Skill/
│   │   ├── CSharp.md         ← C# 编码约定
│   │   ├── AVGEngine.md      ← AVG 剧本引擎架构
│   │   ├── DM_Physics.md     ← 战斗物理体系
│   │   └── Wisdom.md         ← 元认知框架
│   │
│   └── Exp/
│       ├── DearParty.md        ← DearParty 使用指南 ⭐
│       ├── WindowsScript.md  ← bat/PS/VBS 脚本铁律
│       ├── Unity.md          ← Unity 外观层方案
│       ├── Godot.md          ← Godot 外观层方案
│       └── SearxNG.md        ← 本地隐私搜索部署
│
└── L3/                       ← 你的知识沉淀区
    ├── index/                ← 百科级静态知识
    ├── project/              ← 当前项目追踪
    └── history/              ← 项目闭包归档
```
## 如何建立你自己的知识库？

1. **复制本目录** 到你的 DearParty IO 白名单路径下
2. **读 HUB.md** — 这是整个框架的操作手册，包含所有流程和模板
3. **定制 SOUL.md** — 修改身份锚点、思考模式、决策规则，让 AI 按你的方式运转
4. **使用 DearParty 对话** — AI 会自动调用文件工具读写你的知识库
5. **按 HUB.md 的收工流程** 逐步沉淀知识到 L3
6. **积累你自己的 L2-Skill** — 当某类知识跨项目复用 2 次以上，沉淀为 Skill

---

_这是 RanParty 的公开脱敏版本。欢迎 Fork 并建立你自己的知识体系。_
