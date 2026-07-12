# RanParty

RanParty 是面向 Windows 的本地 AI Agent 桌面应用。它将多模型对话、工作区、工具调用、技能（Skill）、专家与专家团整合在一个 Electron 客户端中，并由本地 C# 后端负责模型协议、数据持久化和工具安全策略。

> 当前桌面客户端版本：`1.7.0`<br>
> 运行链路：`Electron + React + C# BackendHost`

## 你可以用它做什么

- 配置并切换 OpenAI Chat Completions、OpenAI Responses、Anthropic Messages 等兼容模型。
- 在工作区中管理任务、会话、附件、产物和历史会话引用。
- 使用 Default、Plan、Ask 等对话模式；Plan 和 Ask 不会直接写入文件或调用工具。
- 让模型在审批与预算限制下使用文件、Shell/PowerShell、网页搜索、文档处理等工具。
- 通过 Skill 广场管理内置、工作区和社区 Skill，并按需把 Skill 加入下一轮上下文。
- 在「专家 / 专家团」中心选择个人专家或多能力团队；点击推荐话术会将专家选择和话术带回输入框，不会自动发送。
- 安装 SkillHub 专家包：专家团以工作流和关联 Skill 组成；只有包含 `soul.md` 的包才会额外提供可选的个人专家。
- 使用内置「美团生活助手」本地模板整理优惠券、团购和附近生活服务信息。它不连接美团账号，不执行下单、支付或领券。

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
- [Electron 开发说明](electron/README.md)

## 贡献

提交改动前，请至少运行与改动范围匹配的类型检查、测试或后端构建。不要提交 `RanPartyData/`、发布产物、SDK 缓存或本地会话数据。
