# DearParty.md — DearParty 多智能体操作系统使用指南

> 版本：1.1-public | 2026-07-02
> 类别：L2-Exp

---

## 一、工具定位

C# 原生多智能体操作系统。Pet FSM 帧循环驱动 + C_CatRegistry 工单路由 + Named Pipe 调试监视器。单进程 Pet 协程 + 看板路由模型——所有子猫在同一进程中以 Pet 协程运行，通过 C_CatRegistry 跨猫路由工单。

**形态：** WinForms 桌面应用（WinExe），27 个 .cs 文件，零外部依赖
**当前阶段：** P2 全部完成，生产就绪

---

## 二、部署/接入

### 前置条件

- .NET 8+ Runtime
- 有效的 DeepSeek API Key（在 https://platform.deepseek.com 获取）
- QQ Bot 可选（需配置 qq_appid / qq_secret）

### 启动

```powershell
# 直接运行（发布版）
.\DearParty.exe

# 调试模式（双窗口，推荐新手使用）
.\DearParty.exe --debug
```

- 主进程启动 WinForms 窗口（F_Main），含对话页 + 配置页
- `--debug` 参数启动监视器子进程（F_Debug），通过 Named Pipe 显示调试信息

### 配置文件

配置文件自动创建于 `DearParty/catconfig/config.cfg`，使用 `ⓐ` 分隔符的键值对格式。可通过 UI 配置页直接修改，支持热更（FileSystemWatcher）。

---

## 三、新手教程 · 第一次使用

> 如果你刚拿到 DearParty.exe，按以下步骤走，5 分钟就能开始对话。

### 第一步：获取 API Key

DearParty 依赖 DeepSeek API 驱动。去 [platform.deepseek.com](https://platform.deepseek.com) 注册账号 → API Keys → 创建新 Key → 复制备用。

### 第二步：启动程序

双击 `DearParty.exe`。首次启动会自动创建配置目录 `DearParty/catconfig/` 和默认配置文件。

你会看到两个窗口：
- **主窗口（左）**：你的对话界面。上方是大片对话区，底部是输入框。
- **监视器窗口（右，仅 --debug 模式）**：调试用，显示帧号/状态/内存/日志。新手可以先不管它。

### 第三步：填入 API Key

1. 点击主窗口顶部的 **「配置」** 标签页
2. 在 **「API Key」** 输入框中粘贴你的 DeepSeek API Key
3. 确认 **「模型」** 栏位（默认 `deepseek-v4-flash`，想用更强的推理可改为 `deepseek-v4-pro`）
4. 点击底部的 **「保存配置」** 按钮

> 💡 API Key 也支持环境变量：设置 `DS_API_KEY` 环境变量后无需在 UI 中填写。

### 第四步：开始对话

切回 **「对话」** 标签页，在底部输入框打字，按 **Enter** 发送。

你会看到：
- 名字行出现 → AI 开始思考
- 帧动画图标旋转（`-\\|/` 表示思考中，`🔧🔨` 表示调用工具）
- 流式文字逐字出现
- 回复末尾显示 token 消耗：`↑2813 ↓139 hit:2701`

### 第五步：日常使用技巧

| 操作 | 方式 |
|------|------|
| 发送消息 | Enter |
| 换行 | Shift + Enter |
| 开新会话 | 输入 `/new` 回车 |
| 滚动锁定 | 点击「锁定滚动」按钮，浏览历史时不自动滚到底 |
| 调整字体 | 配置页 → 字体大小：小(10f) / 中(11f) / 大(12f) → 保存 |
| 设置指令后缀 | 配置页 → 指令后缀（多行），每次对话自动追加（如 `请用中文回答`） |
| 让 AI 操作文件 | 直接说「帮我读一下 xxx.md」，AI 会自动调用文件工具 |
| 查看后台状态 | `--debug` 启动，监视器窗口看帧号/Dogs/Cats/日志 |

### 常见问题

| 问题 | 解决 |
|------|------|
| 发送后没反应 | 检查 API Key 是否正确、网络是否畅通 |
| 回复乱码 | 配置页保存一次配置（触发热更），或重启程序 |
| 文件工具报错 | 确认目标路径在 IO 白名单内（配置页可追加，`|` 分隔） |
| 窗口位置跑了 | 窗口位置会自动保存，下次启动恢复；删掉配置中的 `win_x/y/w/h` 可重置 |

---

## 四、核心操作

### 4.1 对话

- 主窗口对话页输入文本，Enter 发送，Shift+Enter 换行
- 流式回复实时显示，帧动画指示状态（思考/工具/回复）
- Token 消耗显示在每条回复末尾：`↑输入 ↓输出 hit:缓存`

### 4.2 系统指令

在输入框输入 `/` 前缀触发系统指令：

| 指令 | 功能 |
|------|------|
| `/new` | 重置当前会话（归档旧会话→清空上下文） |

### 4.3 配置页

| 配置项 | 说明 |
|--------|------|
| API Key | DeepSeek API 密钥（也支持环境变量 `DS_API_KEY`） |
| 模型 | 全局统一模型（所有猫猫共用） |
| IO 白名单 | 文件工具访问路径（`|` 分隔），相对路径解析到 DearParty 根目录 |
| 字体大小 | 小(10f) / 中(11f) / 大(12f)，仅影响回复正文 |
| 指令后缀 | 每次对话自动注入的 user 消息（多行，ⓑ 编码存储） |
| QQ Bot | 启用/禁用 + AppID + Secret + 沙箱模式 |

### 4.4 文件工具

AI 自动调用 16 个文件/格式化工具（通过 tool_calls 协议）：IOFile 猫执行 15 个 `file_*` 工具，MdCat 猫执行 `reformat_md`。

| # | 工具 | 功能 |
|---|------|------|
| 1 | `file_read` | 全文读取 |
| 2 | `file_read_between` | 纸带区间读取 |
| 3 | `file_write` | 覆写文件 |
| 4 | `file_append` | 追加到文件末尾 |
| 5 | `file_replace` | 纸带替换 |
| 6 | `file_list` | 列出目录直接子项 |
| 7 | `file_find` | glob 搜索文件名 |
| 8 | `file_tree` | 递归目录树 |
| 9 | `file_move` | 移动/重命名 |
| 10 | `file_delete` | 删除文件/空目录 |
| 11 | `file_batch` | 批量写操作 |
| 12 | `file_read_excel` | 读取 .xlsx |
| 13 | `file_write_excel` | 写入 .xlsx |
| 14 | `file_read_docx` | 读取 .docx |
| 15 | `file_write_docx` | 写入 .docx |
| 16 | `reformat_md` | 纯文本 → 规范 Markdown |

另有 `now_time`、`random_int` 两个全局工具（非文件工具）。

### 4.5 QQ Bot 渠道

- 启用后在配置页设置 qqbot_enable=1
- 支持QQBot在沙箱下私聊沟通，目前不支持文件收发
- 消息前缀：`[QQ:private:OpenID]` / `[QQ:group:OpenID]` / `[QQ:channel:OpenID]`
- WebSocket 长连接 + op=6 Resume + 心跳 ACK 检测
- 沙箱模式：qq_sandbox=1 仅收发沙箱群消息

---

## 五、架构速览

### 5.1 猫猫清单（4 只 Pet）

| 猫猫 | 类型 | 职责 | 注册工具 |
|------|------|------|---------|
| **SuperCat** | Cat | 对话中枢 | — |
| **IOFile** | Cat | 文件工具执行 | 16 个 file_* 工具 |
| **MdCat** | Cat | Markdown 格式化 | reformat_md |
| **QQBot** | Cat | QQ Bot 渠道适配 | — |

- **Cats** 不受模态阻塞，**Dogs**（工单执行中的临时 Pet）受模态阻塞
- DogCoroutine 生命周期：S_ROUTE → S_WAITING → S_DONE

### 5.2 工单流程

```
SuperCat 收到 tool_calls
  → 创建 WorkOrder + DogCoroutine
  → C_CatRegistry.Enqueue 投递到目标猫猫候诊队列
  → 目标猫猫执行 → 标记 isDone
  → SuperCat 收集结果 → 注入 tool result → 续传 API
```

### 5.3 会话持久化

- 活跃上下文：`DearParty/catconfig/{catId}_active.txt`（JSON Lines）
- 历史归档：`DearParty/Log/sessionsHistory/`
- API 留档：`DearParty/Log/DearParty yyyy-MM-dd HH-mm-ss/CALL-*.txt`
- 工单归档：`DearParty/Log/DogOA.txt`

### 5.4 窗口布局

| 窗口 | 内容 |
|------|------|
| F_Main | 对话页（RTB 持久区 + Label 动态区浮层 + 输入栏）+ 配置页（11 行） |
| F_Debug | 监视器：Debug（橙色，帧号/状态/内存/Cats/Dogs）+ Log（绿色，最近日志） |

---

## 六、踩坑记录

| 问题 | 说明 | 对策 |
|------|------|------|
| 启动崩溃 | 缺少 catconfig 目录或 config.cfg | C_Config.Init 自动创建默认配置 |
| 文件工具返回 ERR | 路径不在白名单内 | 检查配置页 IO 白名单，相对路径从 DearParty 根目录解析 |
| 流式回复卡住 | DS API 超时或网络波动 | 等待自动重试（C_Api 内置重试），或 /new 重置 |
| QQ Bot 断连 | Token 过期或网络中断 | 自动 RefreshToken + Resume（op=6），心跳 ACK 超时自动重连 |
| 监视器窗口无内容 | Named Pipe 连接未建立 | 确认主进程已启动，等待 3s 自动重连 |
| 配置保存后未生效 | FileSystemWatcher 150ms 延迟 | 等待 0.5s 后自动热更，或重启 DearParty |
| /new 后上下文残留 | 会话重置是异步标志位 | /new 后等待下次对话自动清理 |

---

## 七、关联文档

**本知识库：**
- `../Skill/CSharp.md` — Static C 风格编码约定
- `../../TOOL.md` — 18 个工具完整操作指南
- `../../HUB.md` — 知识架构中枢

**外部资源：**
- [DeepSeek API](https://platform.deepseek.com) — API Key 获取

---

_版本：1.1-public | 2026-06-17 | 脱敏公开版_
