# RanParty

RanParty 是面向 Windows 的本地 AI Agent 桌面应用。它将多模型对话、工作区、工具调用、技能（Skill）、专家与专家团整合在一个 Electron 客户端中，并由本地 C# 后端负责模型协议、数据持久化和工具安全策略。

> 当前桌面客户端版本：`1.7.0`<br>
> 运行链路：`Electron + React + C# BackendHost`

## 你可以用它做什么

- 配置并切换 OpenAI Chat Completions、OpenAI Responses、Anthropic Messages，以及 Kimi Coding 等兼容模型。
- 在工作区中管理任务、会话、附件、产物和历史会话引用。
- 使用 Default、Plan、Ask、Goal 等对话模式；Ask 仅回答问题，Plan 只生成可确认的计划，确认后再执行，Goal 用于持续推进长期目标。
- 让模型在**三级审批**与预算限制下使用文件、Shell/PowerShell、网页搜索、文档处理等工具。
- 通过 Skill 广场管理内置、工作区和社区 Skill，并按需把 Skill 加入下一轮上下文。
- 在「专家 / 专家团」中心选择个人专家或多能力团队；点击推荐话术会将专家选择和话术带回输入框，不会自动发送。
- 安装 SkillHub 专家包：专家团以工作流和关联 Skill 组成；只有包含 `soul.md` 的包才会额外提供可选的个人专家。
- 通过**角色卡系统**为 AI 赋予个性和行为模式（猫娘、管家、导师等），角色会随使用增长并记录关系里程碑。

## 模型配置示例

在「设置 → 模型配置」中可创建多个配置，并在发送消息前切换。Kimi Coding 的推荐配置如下：

| 字段 | 值 |
| --- | --- |
| 协议 | OpenAI Chat Completions |
| Base URL | `https://api.kimi.com/coding/v1` |
| Model | `kimi-for-coding` |
| 上下文窗口 | `262144` |
| 最大输出 | `32768` |

API Key 只通过设置界面录入，并使用 Windows DPAPI 加密保存。不要把真实密钥写入 README、脚本、种子配置或发布产物。

## 稳定性与交互

- 工具循环设有模型轮次、调用次数与子代理轮次上限，并在预算接近耗尽时要求模型收敛和完成必要验证。
- 文件修改后若没有成功的读取、测试、构建或类型检查，后端会追加一次验证机会；无法验证时必须明确说明残留风险。
- 上下文压缩保留最近消息和完整工具结果，旧摘要会标记为背景信息，避免过时状态覆盖最新用户指令。
- 图片附件按结构估算上下文，不再把 Base64 字节长度直接当作模型 Token；兼容接口的流式用量也会计入会话指标。
- 设置支持 `Ctrl+,` 打开和 `Ctrl+S` 保存模型配置；弹窗包含焦点约束，任务选择器支持方向键、Home、End 与 Esc。
- 审批弹窗默认聚焦「拒绝」，Plan 仅在模型输出结束后显示确认操作；窄聊天区会自动重排输入框控制项。

## 工具安全：三级审批

RanParty 对 Shell/PowerShell 命令执行实施三级安全检测：

| 级别 | 说明 | 示例 |
|------|------|------|
| **Tier 0 — 硬阻断** | 无条件拒绝，无法绕过 | `rm -rf /`、`mkfs`、fork bomb、`shutdown` |
| **Tier 1 — 高危** | 始终要求用户确认，即使开启自动模式 | `curl \| sh`、`chmod 777`、`DROP TABLE`、`eval` |
| **Tier 2 — 可确认** | 受 ask/auto 模式控制 | 文件删除、记忆修改、git push --force |

审批决策支持四种级别：
- **仅本次允许** — 当前调用放行
- **允许类似操作** — 当前会话内同参数不再询问
- **始终允许** — 持久化到配置文件，重启后仍生效
- **拒绝** — 阻止本次调用

## 角色系统与情感陪伴

每个模型配置可绑定一张**角色卡**（`Characters/*.md`），定义 AI 的身份锚点、性格、语气和行为模式。内置角色包括：

| 角色 | 文件 | 风格 |
|------|------|------|
| 小然（默认） | `SOUL.md` | 16 岁猫娘，理性建造者，颜文字 |
| 猫娘 | `cat.md` | 精简版 SOUL |
| 管家 | `butler.md` | 克制英式管家，正式语气 |
| 导师 | `tutor.md` | 苏格拉底式导师，反问引导 |
| 中性助手 | `assistant.md` | 纯工具型，零个性 |

角色系统通过以下机制持续进化：
- **growth_record** — 自动记录用户偏好、关系里程碑和性格微调
- **cat_growth.md** — 四维关系档案：熟悉度阶梯（陌生人→熟人→信任者→建造伙伴）、偏好、里程碑、性格微调
- **SOUL.md 情绪模块** — 关系感知、主动关怀、庆祝/安慰/陪伴沉默模式

## 专家、专家团与 Skill 的区别

| 类型 | 用途 | 在输入框中的选择规则 |
| --- | --- | --- |
| Skill | 一项可复用的能力说明或工作流 | 可与专家搭配，用于下一轮上下文 |
| 个人专家 | 带角色说明（Soul）的单一协作者 | 最多选择 3 位 |
| 专家团 | 由负责人工作流与多个关联 Skill 组成的协作团队 | 最多选择 1 个，且与个人专家互斥 |

SkillHub 专家包会安装到全局加载目录 `RanPartyData/RanParty/InstalledSkills`，并将团队清单保存到 `RanPartyData/RanParty/Experts/<pack-id>`。安装过程由后端直接下载、校验、暂存并原子写入，不依赖本机 Python、`skillhub.cmd` 或默认 `./skills` 目录。

## 快速开始（开发）

### 前置条件

- Windows 10/11 x64
- Node.js 20+
- .NET 8 SDK
- npm

### 安装依赖并启动

```powershell
cd electron
npm ci
npm run dev
```

`npm run dev` 会启动 Vite 和 Electron。完整的模型调用、工具调用和数据持久化由 Electron 主进程拉起本地 C# 后端完成。

### 常用命令

```powershell
# 前端类型检查
cd electron
npm run typecheck

# 前端测试
npm test

# 构建前端与 Electron 主进程
npm run build

# 构建后端（仓库根目录）
dotnet build backend\RanParty.Backend.csproj -c Release

# 离线验证集合（仓库根目录）
powershell -ExecutionPolicy Bypass -File tests\verify-offline.ps1
```

## 打包 Windows 版本

```powershell
cd electron
npm run package
```

该命令依次构建前端、发布自包含的 Windows x64 后端，并生成 Electron portable 包。产物目录由 `electron/package.json` 的 `build.directories.output` 配置决定。

首次运行打包版时，应用会在可执行文件旁创建 `RanPartyData/`，用于保存配置、会话、已安装 Skill、专家包和种子数据副本。移动应用时，请将这个目录一并移动。

发布时应始终使用全新的输出目录，并且不要在审计完成前启动 `win-unpacked/RanParty.exe`。交付前至少确认：

- 输出目录中不存在 `RanPartyData/`。
- `resources/seed-data/Config/config.cfg` 与仓库种子配置一致。
- 发布目录中不存在 API Key、测试会话、日志或本机绝对路径。
- 便携包与最终交付副本的 SHA256 一致。

## 验证

完整离线验证命令会依次执行后端构建、核心运行时冒烟、前端契约测试、生产构建和协议冒烟：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File tests\verify-offline.ps1
```

截至 2026-07-14，本轮发布基线为：后端构建 `0` 警告/`0` 错误、`55` 个前端测试、`21` 个协议冒烟全部通过。另使用真实 Kimi Coding 配置完成了模型连接、文件读写、Shell 审批、图片输入、Plan 确认执行、右侧文件/浏览器面板、Skill 与专家目录验收。

## 项目结构

```text
electron/                 Electron 主进程、React 界面与打包配置
backend/                  C# BackendHost：IPC、会话、模型、工具、SkillHub 安装
Core/                     配置、会话存储、Skill 注册表与安全策略
Cats/                     文件、Shell、网页搜索等工具实现
Tools/                    Excel、Word、Markdown 等文档工具
RanParty/                 内置角色、规则、Skill 与专家种子数据
plugins/                  插件与标准 SKILL.md 示例
tests/                    后端、协议与前端冒烟/契约测试
docs/                     架构、专家清单与设计文档
```

## 数据与安全

- API Key 使用 Windows DPAPI 加密，界面仅展示已配置状态。
- 文件访问受工作区和白名单目录限制，并防止通过 Junction/Symlink 绕过。
- Shell/PowerShell 受审批、超时、输出与调用预算限制；命令仍以当前 Windows 用户权限执行。
- 网络工具会拦截本地、内网和危险地址段。
- 社区 Skill 默认显式启用；安装或启用 Skill 不会自动运行其脚本、Hook 或 MCP 服务。
- 发送给第三方模型服务的内容可能包括用户消息、附件、当前会话上下文，以及明确启用的 Skill/专家提示。请按服务商政策配置和使用模型。

## 文档

- [客户端架构](docs/client-architecture.md)
- [专家包清单格式](docs/expert-manifest.md)
- [Skill 市场调研](docs/codex-skill-marketplace-research.md)
- [Agent 工具循环完成策略](docs/agent-loop-completion-design.md)
- [Electron 开发说明](electron/README.md)

## 贡献

提交改动前，请至少运行与改动范围匹配的类型检查、测试或后端构建。不要提交 `RanPartyData/`、发布产物、SDK 缓存或本地会话数据。
