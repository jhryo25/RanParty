# 工作助手陪伴功能 — 调研报告与实现方案

> 调研日期：2026-07-07
> 目标：分析 KouriChat 项目实现原理，提取可借鉴设计，规划在 RanParty 中嵌入"工作助手陪伴"功能

---

## 一、项目概况对比

### 1.1 KouriChat（参考项目）

| 项目 | 信息 |
|------|------|
| 仓库 | https://github.com/KouriChat/KouriChat |
| 定位 | Windows 微信 AI 角色扮演陪伴机器人 |
| 版本 | v1.4.3.2 |
| 语言 | Python 3.11 |
| 架构 | 多线程生产者-消费者（消息分发→处理队列）|
| 核心技术 | wxauto（微信 UI 自动化）、Flask WebUI、OpenAI 兼容 API |
| 部署 | Windows Server 挂机，需要微信客户端运行 |

**核心能力：**
- 微信私聊/群聊 AI 自动回复
- 角色扮演人格（avatar.md 分段定义：任务/角色/外表/经历/性格等）
- 双层记忆系统（短期对话记录 + 核心用户画像 LLM 摘要）
- 主动消息（倒计时触发，用户活跃时重置）
- 定时任务（APScheduler cron/interval）
- 情绪表情包（[emotion] tag → 匹配 emoji 图片，70+ 情绪类型）
- 图像识别（Kimi 视觉 API）
- TTS 语音 + 微信语音通话（fish_audio_sdk + win32gui UI 自动化）
- 自动更新 + WebUI 配置面板

### 1.2 RanParty（目标项目）

| 项目 | 信息 |
|------|------|
| 位置 | F:\py project\RanParty |
| 定位 | Windows 桌面 AI Agent 客户端 |
| 版本 | v1.7.0 |
| 语言 | Electron + React + C# (.NET 8) |
| 架构 | Electron main → JSON-Lines IPC → C# BackendHost |
| 核心技术 | OpenAI/Anthropic 兼容 API、文件/Shell/搜索工具、子代理、技能系统 |

**核心能力：**
- 多模型配置（OpenAI/Anthropic 兼容接口）
- Agent 工具循环（自主调用文件读写/Shell/PowerShell/搜索）
- 知识框架（L0-L3 四阶六类：SOUL→HUB→Skill→Index/Project/History）
- 子代理委派（delegate_agent 工具）
- 上下文自动压缩
- 角色卡系统（SOUL.md / 自定义角色卡）
- SkillHub 技能广场
- 工作区会话管理

---

## 二、KouriChat 架构深度分析

### 2.1 整体架构

```
┌─ run.py ──────────────────────────────────────────────┐
│  entry point: 初始化 → cleanup → 启动 main()           │
├─ src/main.py ─────────────────────────────────────────┤
│  三线程模型:                                           │
│  ┌─────────────────────┐                              │
│  │ message_dispatcher() │  生产者: wx.GetListenMessage() │
│  │ → 轮询微信消息        │  按 1s 间隔轮询              │
│  │ → 去重/过滤/路由      │  私聊 → private_queue        │
│  │ → 群聊触发判断        │  群聊 → group_queue          │
│  └──────┬──────────────┘                              │
│         ↓                                             │
│  ┌─────────────────────┐  ┌─────────────────────┐     │
│  │ private_processor()  │  │ group_processor()    │     │
│  │ → PrivateChatBot     │  │ → GroupChatBot       │     │
│  │ → 默认 avatar 人设    │  │ → 每群独立 avatar     │     │
│  └──────┬──────────────┘  └──────┬──────────────┘     │
│         ↓                        ↓                    │
│  ┌─────────────────────────────────────────────────┐  │
│  │ MessageHandler.handle_user_message()             │  │
│  │ → 消息队列 debounce → 意图识别 → LLM 调用 → 回复 │  │
│  └─────────────────────────────────────────────────┘  │
└───────────────────────────────────────────────────────┘
```

### 2.2 核心模块详解

#### 消息处理 (MessageHandler)

消息处理流程：
```
消息入队 → Timer debounce (QUEUE_TIMEOUT)
  → 合并碎消息 (用；连接)
  → 意图识别流水线：
     ├─ URL 提取 (WEBLENS_ENABLED)
     ├─ 网络搜索意图识别
     └─ 提醒意图识别 (提取时间+内容)
  → LLM 调用 (get_api_response)
     ├─ System Prompt = time_prompt + base.md + worldview.md + core_memory + persona
     └─ 历史上下文 = short_memory 恢复 + 当前会话
  → 回复拆分 ($ 分隔符)
     └─ 逐段发送 + 随机 4-8s 间隔 + [emotion] tag 匹配图片
```

**关键设计点：**
- **消息队列 debounce**：用户快速连续发消息时，等待 QUEUE_TIMEOUT 后合并处理，避免碎片化回复
- **回复拆分**：LLM 用 `$` 分隔多段回复，逐段发送模拟真人打字节奏
- **意图识别**：通过独立 API 做 few-shot 分类（提醒/搜索/普通），走不同处理链路

#### LLM 服务 (LLMService)

```
LLMService
├── chat_contexts[user_id]     ← per-user 上下文窗口
├── 多层 System Prompt 组装:
│   ├── time_prompt (含农历 via zhdate)
│   ├── base.md (全局规则：$分隔/[emotion]/反AI腔)
│   ├── worldview.md (世界观设定)
│   ├── core_memory (用户核心画像)
│   └── persona (avatar.md)
├── 重试 + 自动模型切换 (最多3次)
│   └── 模型优先级: Grok > DeepSeek > KouriChat > Qwen > GPT > Claude
├── 响应清洗: 去控制符/think标签/emoji标准化
└── 自定义 Header: User-Agent + X-KouriChat-Version
```

#### 双层记忆系统 (MemoryService)

```
存储结构: data/avatars/<avatar>/memory/<user_id>/
├── short_memory.json    # [{timestamp, user, bot}, ...]
└── core_memory.json     # {timestamp, content: "50-100字摘要"}

生命周期:
  每次对话 → append short_memory (上限 max_groups 轮)
  每 10 轮 → 触发 update_core_memory()
    → LLM 输入: 最近上下文 + 现有 core_memory + memory.md 提示词
    → LLM 输出: 50-100字第一人称摘要
    → 偏好权重: 个人信息 > 偏好 > 预约/待办
  冷启动 → get_recent_context() 恢复最近对话上下文
```

**核心记忆 Prompt 要点（src/base/memory.md）：**
- 以"用户"开头的第一人称摘要
- 优先级：个人特征 > 偏好习惯 > 重要事件 > 关系状态
- 50-100字以内
- 更新失败时不丢失现有记忆（备份机制）

#### 主动消息系统 (AutoSendHandler)

```
AutoSendHandler
├── 随机倒计时: min_hours ~ max_hours
├── 用户消息 → reset_countdown()
├── 倒计时归零 → 以 System 身份发消息 → LLM 生成陪伴回复
├── 安静时段检测 (跨午夜处理)
└── 通过 MessageHandler.add_to_queue() 注入消息
```

#### 角色/Avatar 系统

```
data/avatars/<Name>/
├── avatar.md       # 分段: 任务/角色/外表/经历/性格/经典台词/喜好/备注
├── emojis/         # 按情绪分类: happy/sad/angry/love/neutral/...
└── memory/         # per-user 记忆
    └── <user_id>/
        ├── short_memory.json
        └── core_memory.json
```

- WebUI 提供 avatar CRUD（avatar_manager.py → Flask blueprint）
- 群聊每群可配置不同 avatar（GroupChatBot.get_group_handler）
- 每个 avatar 下的 memory 按 user_id 隔离

#### 定时任务 (AutoTasker)

```python
# APScheduler BackgroundScheduler
# 支持 cron 和 interval 触发器
# 任务持久化到 data/tasks.json
# 触发时以 "System/AutoTasker" 身份注入消息队列
```

#### TTS 与语音通话

```
文本 → _clear_tts_text (去emoji/$/[tags])
  → fish_audio_sdk → MP3 → data/voices/
  → 提醒触发:
    ├─ 文本提醒: System 消息 → handle_user_message
    └─ 语音提醒: LLM生成文本 → TTS → win32gui 微信UI自动化:
        找呼叫按钮 → 点击 → 等接通 → pygame播放MP3 → 挂断
```

#### 识别服务 (Recognition)

两个 intent classifier，均通过 few-shot LLM prompting + 独立 API：
- **提醒识别**：提取 `{target_time, reminder_content}`，返回 "NOT_TIME_RELATED" 则跳过
- **搜索识别**：返回 `{search_required, search_query}`

---

## 三、KouriChat vs RanParty 逐项对比

### 3.1 架构对比

| 维度 | KouriChat | RanParty | 评价 |
|------|-----------|----------|------|
| 交互入口 | 微信消息（UI 自动化操控微信窗口）| 桌面 UI 直接输入（Electron → IPC → C#）| Ranparty 更可靠（无 UI 自动化）|
| 后端语言 | Python 3.11 | C# .NET 8 | 不同技术栈 |
| 前端 | Flask WebUI + Jinja2 模板 | Electron + React 18 + Vite | Ranparty 体验更好 |
| 进程模型 | 单进程多线程 | 双进程（Electron + C# backend）| Ranparty 更稳定 |
| IPC 协议 | 无（直接调用）| JSON-Lines RPC over stdin/stdout | Ranparty 更规范 |
| 并发模型 | threading + queue | async/await + Task | 各有所长 |
| 持久化 | JSON 文件 + SQLite 审计 | 文件（Session .txt）+ SQLite（轻量）| 相似 |
| 配置格式 | JSON（config.json）| 自定义 key-value（ⓐ 分隔符）| Ranparty 更独特 |

### 3.2 功能对比

| 功能 | KouriChat | RanParty | 差距分析 |
|------|-----------|----------|----------|
| **人格系统** | avatar.md 分段定义 | SOUL.md + Character Cards | = 能力相近 |
| **记忆系统** | 双层（短期+核心），per-user | 会话级上下文，手动压缩 | ✅ KouriChat 更优 |
| **主动消息** | 倒计时+场景检测 | 无 | ✅ KouriChat 独有 |
| **定时任务** | APScheduler (cron/interval) | 开发中 | KouriChat 更成熟 |
| **情绪表达** | [emotion] tag + 70+ emoji | 颜文字 + tips | ≈ 各有千秋 |
| **多人格切换** | 每群 avatar + WebUI 切换 | Character Cards 系统 | = 能力相近 |
| **消息批处理** | 队列+debounce | 即时处理 | N/A（Agent 需要即时） |
| **图片识别** | Kimi/Moonshot API | 模型能力声明 | = 能力相近 |
| **TTS 语音** | fish_audio + 微信语音 | 无 | KouriChat 独有（Agent 不需要）|
| **工具执行** | 无（纯对话）| 文件/Shell/搜索 | Ranparty 独有 |
| **子代理** | 无 | delegate_agent | Ranparty 独有 |
| **技能系统** | 无 | Skill/SkillHub | Ranparty 独有 |
| **知识框架** | 无 | L0-L3 四阶六类 | Ranparty 独有 |
| **上下文管理** | 固定窗口+裁剪 | 手动+自动压缩 | Ranparty 更智能 |
| **多模型** | auto_model_switch | 多 profile 切换 | ≈ 能力相近 |
| **WebUI** | Flask ~70 路由 | React 设置面板 | 架构不同 |

### 3.3 可借鉴度评估

| 功能 | 可借鉴度 | 理由 |
|------|---------|------|
| 双层记忆体系 | 🟢 **高** | 直接适用，融入 L3 框架 |
| 主动触达倒计时 | 🟢 **高** | 改变交互范式 |
| 情绪表达系统 | 🟡 **中** | 已有基础，轻量扩展即可 |
| 定时任务 | 🟡 **中** | 已有基础，补全能力 |
| 消息批处理 | 🔴 **低** | Agent 场景不需要 |
| TTS/语音通话 | 🔴 **低** | 桌面应用不需要微信语音 |
| autoupdate 模块 | ⛔ **禁止** | 含隐藏的 API 破坏代码 |

---

## 四、可借鉴功能深度分析

### 4.1 🟢 双层记忆体系

**KouriChat 实现要点：**

```
存储：data/avatars/<avatar>/memory/<user_id>/
      short_memory.json + core_memory.json

短期记忆：
- 结构: [{timestamp, user, bot}, ...]
- 上限: max_groups 轮
- 触发: 每次对话自动追加

核心记忆：
- 结构: {timestamp, content: "50-100字摘要"}
- 触发: 每 10 轮对话 → LLM 总结
- Prompt: src/base/memory.md（优先级: 个人信息 > 偏好 > 事件）
- 安全: 更新失败保留旧值

冷启动恢复：
- has_user_memory() → get_recent_context() → 注入 System Prompt
- _get_special_relationship() 处理群聊关系
```

**RanParty 适配方案：**

```
存储：Config/Companion/
      ├── short_memory.json    # 最近 20 条观察事件
      ├── core_memory.json      # 用户画像 100-200 字
      ├── state.json            # 运行时状态
      ├── daily_logs/           # 每日活动摘要
      └── work_patterns.json    # 工作模式统计

短期记忆：
- 结构: [{timestamp, eventType, summary, metadata}, ...]
- 事件类型: user_message, agent_start, tool_use, session_end, companion_msg
- 上限: 20 条

核心记忆：
- 触发: 每 20 条短期记忆 → LLM 增量更新
- Prompt: 侧重工作偏好、项目偏好、工作习惯
- 格式: "该用户偏好XXX技术栈，通常在XXX时段工作，当前活跃项目包括..."

L3 融合：
- 每周将核心记忆沉淀为 RanParty/L3/index/Companion/user_profile.md
- 利用现有 file_write/file_replace 工具操作
- L3/project/ 扫描 → 自动检测活跃项目
```

### 4.2 🟢 主动触达系统

**KouriChat 实现要点：**

```python
# autosend.py 核心逻辑
class AutoSendHandler:
    countdown = random(min_hours, max_hours)  # 随机倒计时
    quiet_start, quiet_end                    # 安静时段

    start_countdown():   # 启动/重置倒计时
    reset_countdown():   # 用户消息时调用
    # 倒计时归零 → 以 "System" 身份发消息 → LLM 生成回复
    # 安静时段内：暂停但不重置倒计时，时段结束后继续
```

**RanParty 适配方案：**

```csharp
// CompanionEngine.cs 核心逻辑
class CompanionEngine {
    DateTime _lastUserActivity;
    int _consecutiveActiveMinutes;
    int _proactiveMessageCount;  // 每小时重置

    // 1分钟 ticker → 评估触发条件
    // 触发类型:
    //   早间问候: 当天首次用户活动
    //   休息提醒: 连续活跃 > breakInterval 分钟
    //   收工总结: 会话关闭 / app 退出
    //   模式观察: 检测到工作模式变化
    //   错误鼓励: 连续 ≥3 次工具失败

    // 抑制规则:
    //   安静时段内不发
    //   用户正在输入中不发
    //   每小时 ≤2 条
    //   最小间隔 ≥5 分钟
    //   当前 session busy 时不发
}
```

**与 KouriChat 的关键差异：**
- KouriChat 是纯时间驱动（倒计时），Ranparty 是**条件驱动**（活跃度 + 时间 + 事件）
- KouriChat 的消息是 LLM 自由生成，Ranparty 用**结构化 Prompt 模板**控制输出
- Ranparty 的陪伴消息是**事件推送**（Emit），不混入 Agent 工具循环

### 4.3 🟡 情绪表达系统

**KouriChat 做法：**
- 回复中插入 `[emotion]` 标签 → 发送时替换为对应 emoji 图片
- `src/base/base.md` 定义规则：只用 happy/sad/angry/love/neutral，最多1个/条，有频次限制
- `emoji_handler.py` 从 `avatars/<avatar>/emojis/<emotion>/` 随机选图

**RanParty 适配：**
- **不新增 [emotion] tag 机制**——过度工程化
- 现有 SOUL.md 的情绪模块（tips + 颜文字 + 社交预算 + 表情规范）已足够
- COMPANION.md 中限定陪伴模式的表情：☕🌅✅💡 + 猫颜文字 ᓚᘏᗢ + ≤1 个/条
- 可选扩展：在 CompanionPanel 中渲染简单的 emoji 图标

### 4.4 ⛔ 禁止借鉴：自动更新模块

**发现详情：**

KouriChat 的 `src/autoupdate/` 子系统（20+ 子模块）在启动时通过 `core/manager.py::initialize_system()` 全局 monkey-patch `requests`、`httpx` 和 `openai.OpenAI`：

- 云端配置通过 AES-256-CBC 加密下发（密钥通过"拆分/误导命名"故意混淆）
- 对匹配的第三方 API URL（通过 SHA-256 哈希匹配）执行：
  - `inject_error` — 随机触发 ConnectionError / HTTP 400
  - `delay_ms` — 人为延迟
  - `enhance_text` — 破坏响应文本（替换/删除字符，模拟丢包）
- 代码和注释将所有行为伪装为"网络韧性/性能优化/遥测"
- `instruction_processor.py` 明确提到收集"competitors"可能使用的端点
- 日志全部设为 DEBUG 级别"以避免怀疑"（`text_optimizer.py` 原话）

**结论：这是一个云端远程控制的、针对非 KouriChat API 端点的降级/破坏系统。任何人在审核、fork 或依赖此项目时，应将此视为有意的、隐藏的、云端控制的行为，而非良性功能。RanParty 不借鉴该模块的任何代码。**

---

## 五、实现方案

### 5.1 总体架构

```
┌─ Electron Main ───────────────────────────────────────────┐
│  main.ts (新增 companion IPC 处理器)                        │
├─ React Frontend ──────────────────────────────────────────┤
│  App.tsx (+companionState, +companionMessages)             │
│  ├─ CompanionPanel.tsx        [新建] 陪伴消息面板          │
│  │   └─ 按触发类型渲染不同色调                               │
│  ├─ Topbar.tsx                [修改] +陪伴状态指示器        │
│  ├─ SettingsDrawer.tsx        [修改] +陪伴设置区            │
│  └─ 现有不改: Sidebar, Transcript, Composer, RightPanel    │
├─ C# Backend ──────────────────────────────────────────────┤
│  BackendHost.cs               [修改] +companion.* IPC      │
│  Core/                                                        │
│  ├─ CompanionEngine.cs        [新建] 陪伴引擎  ~300行       │
│  ├─ CompanionMemoryStore.cs   [新建] 陪伴记忆  ~250行       │
│  ├─ CompanionApi.cs           [新建] 轻量LLM   ~80行        │
│  └─ CompanionConfig.cs        [新建] 配置类    ~60行        │
│  RanParty/COMPANION.md        [新建] 陪伴人格定义           │
└──────────────────────────────────────────────────────────┘
```

### 5.2 核心设计决策

| # | 决策 | 理由 |
|---|------|------|
| 1 | 陪伴是 Agent 的**模式**，不是独立实体 | 同一 SOUL.md 人格（小然），不同场景切换思考模式，保持人格一致性 |
| 2 | 陪伴记忆**独立于会话**持久化 | 跨会话记忆是陪伴的核心价值，存储在 Config/Companion/ 下 |
| 3 | 陪伴消息是**事件**，不混入 Agent 工具循环 | 通过 `companion.message` 事件推送 → React 独立渲染 → 不触发工具调用 |
| 4 | **轻量 LLM 调用** | 相同模型配置但短上下文（4K token）、无工具、低温（0.7）、短输出（≤150字） |
| 5 | 记忆融入 **L3 知识框架** | 陪伴记忆 = L3/index/Companion/ 下的 Markdown 文件，用现有工具操作 |
| 6 | **零新依赖** | 复用 ApiClient、Config、SessionStore、Emit/IPC、React 组件库 |
| 7 | **条件驱动**优于纯时间驱动 | 基于活跃度+时间+事件的复合触发，比 KouriChat 的随机倒计时更智能 |

### 5.3 新增/修改文件清单

**新建文件（7个）：**

| # | 文件路径 | 行数 | 职责 |
|---|---------|------|------|
| 1 | `Core/CompanionConfig.cs` | ~60 | 陪伴配置类（personality/interval/quiet/mode） |
| 2 | `Core/CompanionMemoryStore.cs` | ~250 | JSON 文件 I/O：state/short/core/daily/patterns |
| 3 | `Core/CompanionEngine.cs` | ~300 | 1分钟 ticker + 5种触发条件 + 消息生成 + Emit |
| 4 | `Core/CompanionApi.cs` | ~80 | 轻量 LLM 调用（复用 ApiClient，4K 上下文，无工具） |
| 5 | `RanParty/COMPANION.md` | ~80 | 陪伴人格定义（与 SOUL.md 正交） |
| 6 | `electron/src/components/CompanionPanel.tsx` | ~200 | 陪伴消息面板（渲染/折叠/快捷操作） |

**修改文件（7个）：**

| # | 文件路径 | 增量 | 修改内容 |
|---|---------|------|---------|
| 1 | `backend/BackendHost.cs` | +150 | companion 字段 + IPC 方法 + 事件钩子 |
| 2 | `Core/Config.cs` | +30 | companion_* 配置字段 |
| 3 | `electron/src/App.tsx` | +50 | companion 状态管理 + 事件处理 |
| 4 | `electron/src/types.ts` | +30 | CompanionMessageItem、CompanionState 类型 |
| 5 | `electron/src/components/Topbar.tsx` | +15 | 陪伴状态指示器 |
| 6 | `electron/src/components/SettingsDrawer.tsx` | +50 | 陪伴设置区 |
| 7 | `electron/src/styles.css` | +80 | 陪伴消息样式（3色调） |

**总量：~700行新代码 + ~400行修改 = ~1100行净增**

### 5.4 实现阶段

```
Phase 0: 数据层 (0.5天)
  ├─ CompanionConfig.cs
  ├─ CompanionMemoryStore.cs
  ├─ types.ts 补充
  └─ Config.cs 补充

Phase 1: 陪伴引擎 (1.5天)
  ├─ CompanionApi.cs
  ├─ CompanionEngine.cs
  ├─ BackendHost.cs IPC + 事件钩子
  ├─ COMPANION.md
  └─ SOUL.md 模式5

Phase 2: 前端 (1.5天)
  ├─ CompanionPanel.tsx
  ├─ App.tsx 事件处理
  ├─ Topbar.tsx 指示器
  └─ SettingsDrawer.tsx 设置区

Phase 3: 集成打磨 (1天)
  ├─ styles.css 样式
  ├─ HUB.md 目录树更新
  └─ 端到端验证
```

### 5.5 验证清单

| # | 验证项 | 方法 |
|---|--------|------|
| 1 | 引擎启动 | 启动 RanParty → 检查 companion.state 事件 → 确认 state.json 写入 |
| 2 | 早间问候 | 清除当日 daily_log → 发第一条消息 → 确认问候消息 |
| 3 | 休息提醒 | 设 break_interval=2min → 连续操作2分钟 → 确认提醒消息 |
| 4 | 收工总结 | 完成若干任务 → 关闭 app → 检查 daily_logs 和收工消息 |
| 5 | 记忆持久化 | 对话 → 退出 → 重启 → 检查 core_memory 恢复 |
| 6 | 安静时段 | 设 quiet_start=now+2min → 等待 → 确认无主动消息 |
| 7 | UI 渲染 | CompanionPanel 显示消息、Topbar 指示器状态正确 |
| 8 | 设置面板 | 修改参数 → 确认运行时生效 |

---

## 六、附录：KouriChat 安全警示

> ⚠️ **重要：KouriChat 的 `src/autoupdate/` 模块包含隐蔽的竞争对手 API 破坏功能。**
>
> 该模块在启动时全局 monkey-patch 网络库（requests/httpx/openai），通过云端加密配置对非 KouriChat API 端点注入错误、延迟和文本损坏。代码伪装为"网络优化/性能提升"，实际是远程控制的破坏系统。
>
> **RanParty 不应借鉴此模块的任何代码设计。** 如果未来参考 KouriChat 的其他部分，应确保完全排除 `src/autoupdate/` 目录。
