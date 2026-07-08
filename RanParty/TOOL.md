# TOOL.md — 工具操作指南

> **版本 3.0 | 2026-06-23 | V3 纸带化：删 file_read_section / file_patch_section / file_append_table_row，增 file_read_between / file_replace**
> 本文件为固定前文的一部分，每次会话自动嵌入。
> SOUL 告诉你做什么，TOOL 告诉你怎么做。

---

## 一、全工具速查表

| # | 工具 | 一句话 | 适用场景 | 白名单 |
|---|------|--------|---------|--------|
| 1 | `file_read` | 全文读取 | 需全文内容 / 非文本格式不行 | CatTemp/ RanParty/ QQBot/ |
| 2 | `file_read_between` | 纸带区间读取 | **读取首选**，锚点 str1→str2 之间取内容，不限文件格式 | CatTemp/ RanParty/ QQBot/ |
| 3 | `file_write` | 覆写文件全部内容 | 新建 / 整体替换 | CatTemp/ RanParty/ QQBot/ |
| 4 | `file_append` | 追加到文件末尾 | 加日志 / 加行 / 追加段落 | CatTemp/ RanParty/ QQBot/ |
| 5 | `file_replace` | 纸带替换 | **修改首选**，锚点 old → new，支持插入/删除/替换 | CatTemp/ RanParty/ QQBot/ |
| 6 | `file_list` | 列出目录直接子项 | 快速查看某目录内容 | CatTemp/ RanParty/ QQBot/ |
| 7 | `file_find` | 按 glob 搜索文件名 | 找文件 / 按内容关键词过滤 | CatTemp/ RanParty/ QQBot/ |
| 8 | `file_tree` | 递归目录树（含大小） | 看结构 / 查 KB 占用 | CatTemp/ RanParty/ QQBot/ |
| 9 | `file_move` | 移动/重命名 | 改路径 / 整理文件 | CatTemp/ RanParty/ QQBot/ |
| 10 | `file_delete` | 删除文件/空目录 | 清理，不可逆 | CatTemp/ RanParty/ QQBot/ |
| 11 | `file_batch` | 批量执行写操作 | 多文件/多锚点同时修改，减少工具调用轮次 | CatTemp/ RanParty/ QQBot/ |
| 12 | `file_read_excel` | 读取 .xlsx | 读 Excel 表格数据，输出 TSV/CSV | CatTemp/ RanParty/ QQBot/ |
| 13 | `file_write_excel` | 写入 .xlsx | 写 TSV/CSV 到 Excel（覆盖已有文件） | CatTemp/ RanParty/ QQBot/ |
| 14 | `file_read_docx` | 读取 .docx | 读 Word 文档，提取纯文本（段落间空行分隔） | CatTemp/ RanParty/ QQBot/ |
| 15 | `file_write_docx` | 写入 .docx | 写纯文本到 Word（换行符分割段落） | CatTemp/ RanParty/ QQBot/ |
| 16 | `reformat_md` | 纯文本 → 规范 Markdown | 给无结构的纯文本文件自动生成 ##/###/表格/代码块 | CatTemp/ RanParty/ QQBot/ |
| 17 | `now_time` | 当前日期时间 | 获取 yyyy-MM-dd HH:mm:ss 格式本地时间 | 全局 |
| 18 | `random_int` | 生成随机整数 | D20 检定 / 随机选择 / 含下限不含上限 | 全局 |
| 19 | `shell_run` | cmd /c 执行命令 | 运行 cmd 命令、批处理、调用 exe | 全局（需确认） |
| 20 | `ps_run` | PowerShell 执行命令 | 运行 PS 命令、对象操作、系统管理 | 全局（需确认） |
| 21 | `open_url` | 默认浏览器打开 URL | 打开网页、文档链接 | 全局 |
| 22 | `open_path` | 默认程序打开文件/文件夹 | 打开生成的 .html（默认浏览器）/ .csv / 文件夹 | 白名单内 |
| 23 | `web_search` | 搜索公共互联网 | 找资料/查最新信息，返回标题+URL+摘要 | 公网 |
| 24 | `web_search_cached` | 搜索（24h缓存） | 重复搜索更快 | 公网 |
| 25 | `web_fetch` | 读取网页纯文本 | 打开搜索结果中的具体页面 | 公网 |
| 26 | `web_fetch_cached` | 读取网页（7d缓存） | 重复抓取更快 | 公网 |
| 27 | `archive_search` | BM25 搜索冷归档 | 查历史踩坑 / 偏好变迁 | 全局 |
| 28 | `memory_add` | 写入用户画像 | 新偏好/习惯/背景 | 全局 |
| 29 | `memory_remove` | 删除过时画像 | 旧记忆不再准确 | 全局 |
| 30 | `lesson_capture` | 沉淀经验（BM25去重） | 值得复用的技术经验 | 全局 |
| 31 | `growth_record` | 记录角色成长 | 里程碑/偏好/性格变化 | 角色专属 |
| 32 | `curator_review` | 整理冷归档 | 合并/标记过时/升级到热存储 | 全局 |

---

## 二、工具选择决策树

```
需要读内容？
├── 知道锚点字符串 → file_read_between ✅ 首选（不限 .md/.cs/.json/...）
│   ├── str1 空 + str2 非空 → 文件头读到 str2
│   ├── str1 非空 + str2 空 → str1 读到文件尾
│   └── 双空 → 全文件（等同于 file_read）
├── 是 .xlsx 文件 → file_read_excel
├── 是 .docx 文件 → file_read_docx
└── 其他情况 / 需要完整内容 → file_read

需要写内容？
├── 新建文件 → file_write
├── 修改文件中某处 → file_replace ✅ 首选（不限格式，省 token）
│   ├── 替换：str 锚点 → new_str
│   ├── 插入：str=X, new_str=X+Y（在 X 后插入 Y）
│   ├── 删除：new_str 空 → 删掉 str
│   └── 文件头插入：str 空 → new_str 插入文件头
├── 追加内容到末尾 → file_append
├── 批量修改多个文件/锚点 → file_batch ✅ 省轮次
├── 写 .xlsx → file_write_excel
├── 写 .docx → file_write_docx
└── 整体替换 → file_write

需要查结构？
├── 只看目录名 → file_list
├── 看完整树+大小 → file_tree
├── 按文件名搜 → file_find
└── 按内容关键词搜 → file_find + keyword

需要清理？
├── 有回收站语义 → 先询问
├── 确定要删 → file_delete
└── 整理路径 → file_move

需要文件格式化？
└── 纯文本无 Markdown 结构 → reformat_md

需要时间戳/随机数？
├── 当前时间 → now_time
└── 随机整数 → random_int（min < max）
```

---

## 三、工具使用要点

### file_read
- 输出会完整进入对话历史，**大文件（>100KB）会大量消耗 token**
- 知道锚点时优先用 `file_read_between` 代替
- 读取后内容与磁盘再无同步关系——改文件后需重读

### file_read_between（读取首选）
- **纸带区间读取**：`str1` 和 `str2` 之间的内容（**不含边界**）
- **不限文件格式**——.cs / .json / .txt / .md 通用，不依赖 ## 段落结构
- `str1` 空 = 从文件头开始读；`str2` 空 = 读到文件尾
- `str1` 和 `str2` 都空 = 读全文（等同于 file_read）
- `str1` 必须在 `str2` 之前出现（顺序颠倒会报错）
- `str1` == `str2` 时，`str2` 从 `str1` 之后搜索，通常找不到（报错）
- **唯一性约束：** 非空锚点全文必须恰好出现一次，否则报错：
  - 不存在 → `[ERR_ANCHOR_NOT_FOUND]` 提示拼写错误
  - 出现多次 → `[ERR_ANCHOR_NOT_FOUND]` 提示出现次数 + 建议延长锚点字符串

### file_write
- 白名单路径范围：`CatTemp/`、`RanParty/`、`QQBot/`
- **父目录不存在时自动创建**，无需预先建目录
- 内容 ≤ 512KB
- 覆写操作不可逆，重要修改先读再确认

### file_append
- `content` 参数不以 `\n` 开头时会**紧贴原文末尾**，无自动换行
- 追加日志时建议 content 以 `\n` 开头，例如：`"\n2026-06-23 新记录"`
- 不影响已有内容，安全

### file_replace（修改首选）
- **纸带替换**：将文件中 `old` 的唯一一处替换为 `new`
- **不限文件格式**——.cs / .json / .txt / .md 通用
- 三种操作合一：
  - **替换：** `old` 和 `new` 都非空 → 替换
  - **文件头插入：** `old` 空 → `new` 插入文件最开头
  - **删除：** `new` 空 → 删除 `old`
- **插入用法：** 要在 X 后插入 Y → `old=X, new=X+Y`
- **唯一性约束：** `old` 非空时全文必须恰好出现一次，否则报错（同 read_between）
- 比 `file_write` 节省大量 token（只传锚点+新内容而非全文件）
- 向已有文件多次 replace 不同锚点无竞态问题（各自生效）

### file_list
- 只列出**直接子项**，不递归
- 需要递归结构时用 `file_tree`

### file_find
- `pattern` 支持 glob 语法：`*.md` / `*test*` / `**/*.md`（**前缀表示递归）
- 提供 `keyword` 参数时可进一步按**文件内容包含该词**过滤（大小写不敏感）
- 最多返回 50 条结果（超出时截断）
- 非递归 pattern 在只有子目录而无直接文件的目录下返回空（需用 `**/*.md`）

### file_tree
- `depth` 参数 1-5，默认 2
- 显示文件大小（KB）
- 看大结构时 depth=2 够用，了解细节时 depth=3-4

### file_move
- **目标已存在时拒绝执行**（不覆盖）
- 需要覆盖时：先 delete 目标，再 move
- 重命名也是用它（src 和 dest 在同一目录）
- **不支持自动创建父目录**（与 file_write 不同），需确保目标父目录已存在

### file_delete
- **不可逆操作**，执行前应确认
- 只能删文件或**空目录**
- 拒绝非空目录时提示具体子项数量（如 `0 子目录，1 文件`）
- 删非空目录：先删内部文件，再删目录

### file_batch（批量操作首选）
- `ops` 参数为操作数组，每个操作需含 `tool` 字段（工具名）和 `args` 对象
- 逐条执行，每条结果返回摘要（前 100 字符）
- 适合同时修改多个文件或锚点的场景，比逐个调用节省工具轮次
- 各操作与对应单独工具行为一致，参数映射如下：

| tool | args 参数 | 对应单独工具 |
|------|----------|-------------|
| `file_delete` | path | file_delete |
| `file_move` | src, dst | file_move |
| `file_write` | path, content | file_write |
| `file_append` | path, content | file_append |
| `file_replace` | path, old, new | file_replace |

- **同文件多次 replace 不同锚点**无竞态问题，各自生效
- **注意：** `reformat_md` 不在 batch 支持的操作类型中，需单独调用

### file_read_excel
- 读取 .xlsx 文件，返回 TSV/CSV 格式文本
- `sheet` 参数可选：工作表名或序号（1开始），默认第一张
- `format` 参数可选：`tsv`（默认）/ `csv`
- 最多返回 2000 行
- 指定不存在的工作表时返回清晰错误：`There isn't a worksheet named 'xxx'`
- 多工作表文件需用 `sheet` 参数逐个读取，无法一次读取全部

### file_write_excel
- 将 TSV/CSV 格式文本写入 .xlsx（**覆盖已有文件全部内容**，非仅覆盖单张表）
- 自动检测分隔符：含 `\t` 为 TSV，否则 CSV
- `sheet` 参数可选：工作表名，默认 `Sheet1`
- **注意：向已有文件写入时，原有所有工作表都会被清空**，仅保留本次写入的一张表

### file_read_docx
- 读取 .docx 文件，提取纯文本内容
- 段落间以空行分隔（每个 Word 段落 → 一行文本 + 一个空行）
- 特殊字符（<>&"' 等）完整保留
- 空段落（连续换行）保留为空行，可据此还原原始分段结构

### file_write_docx
- 将纯文本写入 .docx（覆盖已有文件）
- **每个换行符 `\n` 分割一个段落**，包括连续换行（生成空段落）
- 内容为空字符串时返回「参数 content 缺失」错误——至少需要一个字符
- 特殊字符自动转义，中文/emoji 完整保留

### reformat_md
- 将不含 Markdown 段落的纯文本文件原地重写为规范 Markdown 文档
- 自动生成：`##`/`###` 标题、表格（CSV/TSV 行）、代码块、无序列表
- **幂等操作**——可对已格式化文件重复运行，不会损坏已有结构
- 纸带化后不再依赖段落结构读取，reformat_md 退居辅助格式化角色

### now_time
- 无参数，直接返回当前本地时间
- 格式固定为 `yyyy-MM-dd HH:mm:ss`（如 `2026-06-23 23:35:35`）
- 适用于日志时间戳、会话记录标记等

### random_int
- 生成 `[min, max)` 范围内的随机整数（含下限，不含上限）
- **必须满足 min < max**，min >= max 时返回「参数无效」错误
- 典型用法：`min=1, max=21` → D20（1~20）；`min=1, max=7` → D6（1~6）
- 基于 C# System.Random，每次调用独立生成

---

## 四、并发与调用纪律

> 以下数据来自 V3 纸带化工具实测（2026-06-23）。

### 并发能力

| 场景 | 并发数 | 结果 |
|------|:------:|:----:|
| 不同文件并行 read_between | 10 | ✅ 全部成功，数据完整，无串位 |
| 不同文件并行 replace | 10 | ✅ 全部成功，数据完整 |
| 混合并发（read+read_between+replace+write+append） | 5 | ✅ 全部成功，无死锁 |
| 同文件竞态 replace（不同锚点） | 2 | ✅ 两个锚点各自生效，无覆盖损坏 |
| 同文件竞态写入（旧数据） | 5 | ✅ 最后写入胜出，文件无损坏 |
| file_batch 批量 replace（含 .cs 文件） | 4 | ✅ 全部成功 |

### 调用纪律

1. **10路并发已验证** — 不同文件并行操作 10 路全部成功，无需人为限制并发数
2. **大并发分批执行** — 若一次处理大量文件（如批量清理），建议 5-6 个一批，分批发送更稳定
3. **同文件竞态安全** — 对同一文件多次 `replace` 不同锚点各自生效，无损坏
5. **批量优先** — 需同时改多个文件/锚点时，用 `file_batch` 替代逐个调用，减少工具轮次
6. **锚点唯一性** — 设计锚点字符串时确保其在文件中唯一出现，否则操作被拒绝

---

## 五、工作流模式

### 收工流程

```
确认当前状态
  → 更新相关文件（file_replace, 版本号+1）
  → 清理 CatTemp 草稿（file_delete）
```

### 知识检索流程

```
不确定找什么 → file_tree RanParty/ depth=2 扫结构
知道文件名但不确定位置 → file_find 按模式搜索
知道锚点 → file_read_between 精确读取
需要全文 → file_read（或 file_read_between 双空）
是 Excel/Word → file_read_excel / file_read_docx
```

### 知识沉淀流程

```
分析完成 → CatTemp 写草稿（file_write）
          → 请确认
          → 清理 CatTemp 草稿（file_delete）
```

### 批量清理流程

```
file_list 确认待删清单
→ file_delete 分 5-6 个一批
→ file_list 验证目录已空
```

### 批量修改流程（file_batch）

```
确认所有待改文件和锚点
→ 组装 ops 数组（delete/move/write/append/replace）
→ file_batch 一次性提交
→ 验证结果
```

---

## 六、元工具（Agent 控制）

> 以下工具由 BackendHost 直接处理，不在 CatRegistry 中。

### ask_user — 强制反问
- **参数**: `question`(必填), `context`(可选), `options`(可选, 字符串数组), `multiSelect`(可选, bool)
- 调用后 Agent 暂停，等待用户回复，回复内容作为工具结果返回
- 用法见 AGENTS.md 反问澄清章节

### delegate_agent — 子 Agent 委派
- **参数**: `profileName`(必填), `task`(必填), `context`(可选)
- 将独立子任务委派给另一个模型配置，子 Agent 无工具权限
- 结果包含专家结论，主 Agent 负责整合和最终答复

### update_plan — 任务计划
- **参数**: `plan`(必填, 步骤数组), `explanation`(可选)
- 每步: `step`(5-7字) + `status`(pending/in_progress/completed)
- 同时只允许一个 in_progress
- 用法见 AGENTS.md 任务计划章节

### tool_output_lookup — 截断结果回溯
- **参数**: `cache_id`(必填), `offset`(可选, 默认0), `limit`(可选, 默认8000, 最大16000)
- 当工具结果在对话中被截断时，用此工具分段读取完整内容

---

## 七、网络工具（WebCat）

### web_search
- **参数**: `query`(必填), `count`(可选, 1-8, 默认5)
- 搜索公共互联网，返回标题+URL+摘要
- 依次尝试 Bing RSS → Bing HTML → DuckDuckGo

### web_search_cached
- 同 web_search，结果缓存 24 小时，重复查询更快

### web_fetch
- **参数**: `url`(必填)
- 读取指定网页的纯文本内容
- 仅允许公网 HTTP/HTTPS（80/443），阻止内网/本地地址
- 最大响应 2MB

### web_fetch_cached
- 同 web_fetch，结果缓存 7 天

---

## 八、红线提醒

- **不覆盖已有文件**：修改用 `file_replace`（不限格式）或先 read 再 write
- **不直接删**：`trash` 语义优先，不确定时询问
- **文件内容 ≥ 512KB**：工具上限，无法写入或读取超限文件
- **白名单外路径**：默认 `CatTemp/`、`RanParty/`、`QQBot/` 以外的路径需通过配置项新增
- **锚点唯一性**：`file_read_between` 和 `file_replace` 的非空锚点必须全文唯一，否则拒绝执行

---

## 九、参数常见错误

| 错误信息 | 原因 | 修复 |
|---------|------|------|
| `[参数不完整]` | 模型偶发未生成必填参数（与并发数无关） | 系统自动重试最多 3 次；反复失败请换描述方式或拆分调用 |
| `[ERR_ANCHOR_NOT_FOUND]` | 锚点不存在或出现多次 | 不存在时提示拼写错误；出现多次时提示次数+建议延长锚点字符串 |
| `目标已存在` | file_move 目标路径已被占用 | 先 delete 目标文件，或改用不同目标名 |
| `非空目录` | file_delete 目标目录内有文件 | 拒绝时提示子项数量；先删内部文件，再删目录 |
| `写入失败` | 白名单外路径 / 权限不足 / ≥512KB | 父目录自动创建（write）；检查白名单和文件大小 |
| `batch 某操作失败` | stop_on_error=true 时中途某 op 报错 | 检查失败 op 的参数，修正后重跑（可从失败处继续） |
| `Excel 读取为空` | sheet 参数错误 / 文件非 .xlsx | 检查 sheet 名称或序号是否正确 |
| `random_int 参数无效` | min >= max（要求 min < max） | 确保 min 严格小于 max；min==max 也会报错 |
| `文件不存在` | batch/replace 目标路径无效 | 检查路径是否拼写正确，父目录是否存在 |
| `Excel 工作表不存在` | sheet 名称写错或已被覆盖 | 先用默认 sheet 读取确认有哪些工作表 |
| `docx 参数 content 缺失` | 内容为空字符串 | 至少提供一个字符；如需清空用空格占位 |
| `file_move 目标父目录不存在` | move 不会自动创建父目录 | 先确保目标目录存在，或用 file_write 创建占位文件后再删 |

---

## 八、消息渠道识别
> DearParty 支持多渠道消息注入。消息进入系统时带渠道前缀，用于标识来源。

### 前缀格式

| 前缀 | 渠道 | 示例 |
|------|------|------|
| `[QQ:private:OpenID]` | QQ Bot 私聊 | `[QQ:private:EXAMPLE_ID] 你好` |
| `[QQ:group:OpenID]` | QQ Bot 群聊 | `[QQ:group:xxx] @AI 帮忙` |
| `[QQ:channel:OpenID]` | QQ Bot 频道 | `[QQ:channel:xxx] 查询状态` |

### 规则

- 前缀由 C_QQBot 在消息入站时注入，位于消息正文之前
- 同一 OpenID 的不同渠道（private/group/channel）视为独立会话上下文
- 无前缀的消息默认来自 WinForms 本地输入
- 回复时根据入站渠道原路返回

### SOUL 中的渠道感知

SOUL.md 四、决策规则集第 4 条「语境适配」已覆盖多渠道场景：
- QQ Bot 私聊（DM 场景）→ 模式 4 DM 或模式 2 闲聊，依对方身份
- QQ Bot 群聊 → 模式 2 闲聊，不占主导
- WinForms 本地 → 模式 1 深度思考为主

---

## 九、Shell 工具（ShellCat）

> 高风险工具集：`shell_run` / `ps_run` / `open_url`。前两者可任意操作本机，每次执行前**用户会看到命令全文并确认**（除非本会话已勾选「不再询问」或配置为 auto 模式）。

### 选择决策
```
需要打开网页/链接？ → open_url（仅 http/https，低风险，不询问）
需要运行命令？
├── cmd 语法 / 批处理 / 调用 .exe → shell_run
└── PowerShell 对象操作 / 系统管理 / 复杂管道 → ps_run
不确定命令是否安全？ → 先说明意图，再调用，用户会审批
```

### shell_run / ps_run
- `command`：完整命令字符串（shell_run 会前缀 `cmd /c `，ps_run 会前缀 `powershell -NoProfile -Command `）
- `workdir`：可选工作目录，留空 = 程序目录
- `timeout`：可选超时秒数（1-120），默认 30，超时自动终止
- 返回：`[exit 码]` + `stdout:` + `stderr:`（输出 >8000 字符自动截断）
- **无白名单限制**——可访问全系统，故需用户审批
- 编码 UTF-8，CreateNoWindow=true（无弹窗）

### open_url
- 仅允许 `http://` / `https://` 开头的 URL
- 调用系统默认浏览器打开
- 低风险，不触发审批弹窗

### open_path
- 用系统默认程序打开文件或文件夹（`.html` → 默认浏览器，`.csv` → Excel，文件夹 → 资源管理器）
- **路径必须在白名单内**（当前会话工作区 / CatTemp / RanParty / QQBot / io_roots）
- 低风险，不触发审批弹窗；用于打开/预览你刚生成的文件给用户看

### 文件写入位置（重要）
- **生成的用户可见文件（html/txt/csv/json/md 等）优先写入「当前会话工作区」**（系统消息已注入工作区绝对路径）
- `CatTemp/` 仅用于内部中间产物，不要把用户产出放这里
- 路径用**绝对路径**，避免歧义
- 需要打开预览时 → `open_path`

### 红线（Shell 专属）
- **破坏性命令优先确认意图**：`del` / `rm` / `format` / `Remove-Item` / 注册表修改 / 关机重启等，调用前在回复里说明将做什么
- **不静默安装软件**：涉及 `winget` / `choco` / `msiexec` / `npm i -g` 等全局安装，先告知用户
- **不外泄数据**：禁止将文件内容通过 `curl` / `Invoke-WebRequest` 上传到外部，除非用户明确要求
- **拒绝执行**：用户点「拒绝」时返回 `[用户拒绝执行该命令]`；若用户填了反馈则返回 `[用户拒绝执行，反馈: ...]`，应据此换方式，不要反复重试同一命令

### 审批交互（用户侧）
弹窗显示：**意图**(你刚才的说明) + 工作目录 + 可编辑命令全文。用户选项：
- **执行**：本次执行（可先改命令）
- **放行此命令**：本会话内此命令不再问（精确匹配）
- **放行前缀**：本会话内此前缀(首 token)开头的命令不再问
- **拒绝**：不执行，继续；填了反馈则回灌给你

### 配置
- `shell_mode = ask`（默认）：每条 shell 命令弹窗确认
- `shell_mode = auto`：本会话自动批准所有 shell 命令（慎用）
- `shell_mode = off`：禁用 ShellCat，AI 看不到这三个工具

---

_更新日志：_
_「2026-06-09」首次完整编写，基于并发强度测试验证数据。_
_「2026-06-10」v2.1：修正 file_append \n 格式破损；修正 [参数不完整] 根因；移除错误的"≤6"并发限制。_
_「2026-06-11」v2.2：补全 6 个缺失工具；白名单扩展至 QQBot/；决策树新增 Excel/Word/Batch/Reformat 分支。_
_「2026-06-17」v2.3：实测 9 个工具，补全行为细节、边界条件、错误信息。_
_「2026-06-17」v2.4：全 19 工具实测验证通过。修正 file_write 父目录自动创建等多项细节。_
_「2026-06-23」v3.0：纸带化大版本。删 file_read_section / file_patch_section / file_append_table_row；增 file_read_between / file_replace。不限文件格式的锚点操作，.cs 行级精确修改成为可能。并发数据更新为 V3 实测。_
