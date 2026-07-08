# RanParty 自进化系统 — 双轨 + RAG + 去重 + 用户管理

> 版本 2.0 | 2026-07-08

---

## 一、架构总览

```
┌──────────────────────────────────────────────────────────────┐
│ SESSION START: EnsureL0 注入                                   │
│                                                               │
│  角色卡 + _growth.md      角色成长轨迹         ~4K tokens     │
│  AGENTS.md                运行规则             ~1K tokens     │
│  TOOL.md                  工具指南             ~5K tokens     │
│  HUB.md                   中枢索引             ~1K tokens     │
│  MEMORY.md                热用户画像 (2K)      ~700 tokens    │
│  LESSONS.md               热经验精华 (3K)      ~1K tokens     │
│  _search_index.md         冷存储索引 (0.5K)    ~200 tokens    │
│                                                               │
│  总注入 ≈ 13K tokens（与当前持平）                               │
├──────────────────────────────────────────────────────────────┤
│ CONVERSATION: 工具循环                                         │
│                                                               │
│  archive_search(query)     BM25 检索冷归档      按需          │
│  memory_add/remove         维护热用户画像        按需          │
│  lesson_capture            沉淀经验（带去重）    用户触发      │
│  growth_record             记录成长事件          用户确认      │
│  curator_review            整理冷归档            用户触发      │
├──────────────────────────────────────────────────────────────┤
│ TURN END: 反思触发                                             │
│                                                               │
│  每 10 轮 → 反思 prompt → AI 盘点 → 写 MEMORY/LESSONS         │
│  冷归档 > 200 条或 > 14 天未整理 → 建议 curator_review          │
├──────────────────────────────────────────────────────────────┤
│ COLD STORAGE: 无限增长，BM25 检索                               │
│                                                               │
│  MEMORY_archive.md         偏好变迁史            去重追加     │
│  LESSONS_archive.md        踩坑留档 (含去重)     去重追加     │
│  curator_review 定期压缩：合并同类项 → 标记过时 → 分年归档     │
├──────────────────────────────────────────────────────────────┤
│ 前端管理界面                                                    │
│                                                               │
│  设置页 → 「知识管理」Tab                                       │
│  ├── 查看/搜索 MEMORY.md                                       │
│  ├── 查看/搜索 LESSONS.md                                      │
│  ├── 查看/搜索冷归档                                            │
│  ├── 手动编辑/删除条目                                          │
│  ├── 查看进化时间线                                             │
│  └── 一键触发 curator_review                                    │
└──────────────────────────────────────────────────────────────┘
```

---

## 二、冷热知识生命周期

```
                    ┌──────────────┐
   新经验 ──────────→│ lesson_capture│
                    └──────┬───────┘
                           │
                    ┌──────▼───────┐
                    │  BM25 去重    │
                    │  vs 冷归档    │
                    └──┬───────┬───┘
                       │       │
              相似项存在   没有匹配
                       │       │
              ┌────────▼──┐  ┌─▼──────────┐
              │ 更新时间戳  │  │ 新增条目    │
              │ hits += 1  │  │ 冷归档追加  │
              │ 追加 also  │  └────┬───────┘
              └─────┬──────┘       │
                    │              │
              hits>3│              │
                    ▼              │
              ┌──────────┐        │
              │ 升级到    │        │
              │ LESSONS.md│       │
              │ (热存储)  │        │
              └──────────┘        │
                    │              │
                    ▼              ▼
              ┌──────────────────────┐
              │   curator_review     │
              │   每 30 天 / 200 条   │
              │  合并同类 标记过时     │
              │  超老按年分拆          │
              └──────────────────────┘
```

---

## 三、BM25 去重逻辑

### lesson_capture 工具流程

```
输入: title, content, source

步骤 1: 提取关键词
  title 拆词 + content 前 100 字拆词 → 去停用词 → 取前 5 个名词

步骤 2: BM25 搜索冷归档
  用关键词搜索 LESSONS_archive.md 和 MEMORY_archive.md

步骤 3: 去重判断
  如果 top-1 BM25 score > 阈值(2.5)
     且 关键词与 best match 重叠 > 60%
  → 这不是新条目，是已有经验的再次出现
  → 更新该条目的时间戳、hits+1、追加 also
  → 如果 hits > 3，提示"这条经验出现了 {hits} 次，建议升级到 LESSONS.md"

  否则 → 追加新条目到冷归档

步骤 4: 索引更新
  同步更新 _search_index.md
```

### 条目格式

```markdown
[2026-06-25|2026-07-08] dotnet publish 找不到 runtime
  → category: 构建/CICD
  → 解决: restore -r win-x64 再 publish
  → hits: 2 | resolved: true
  → also: 2026-07-08 同一台机重装系统后复现，确认方案有效
  → source: RanParty 首次打包 | 打包迭代
---
[2026-06-20] [obsolete: .NET 8 已内置支持] .NET 6 不支持 required 修饰符
  → category: C#/语言特性
  → hits: 1 | resolved: obsolete
  → source: 旧项目迁移
---
```

---

## 四、BM25 实现

```csharp
// 核心 ~60 行，零依赖
static class Bm25
{
    const double k1 = 1.5, b = 0.75;

    public static List<(int index, double score)> Search(string query, List<string> docs, int topK = 3)
    {
        var qWords = Tokenize(query);
        int N = docs.Count;
        double avgdl = docs.Average(d => Tokenize(d).Count);
        var scores = new List<(int idx, double score)>();

        for (int i = 0; i < N; i++)
        {
            var dWords = Tokenize(docs[i]);
            double score = 0;
            foreach (var qw in qWords.Distinct())
            {
                int df = docs.Count(d => Tokenize(d).Contains(qw));
                double idf = Math.Log((N - df + 0.5) / (df + 0.5) + 1);
                int tf = dWords.Count(w => w == qw);
                double norm = k1 * (1 - b + b * dWords.Count / avgdl);
                score += idf * (tf * (k1 + 1)) / (tf + norm);
            }
            if (score > 0) scores.Add((i, score));
        }
        return scores.OrderByDescending(s => s.score).Take(topK).ToList();
    }

    static List<string> Tokenize(string text)
        => text.ToLowerInvariant().Split(new[] { ' ', '\n', '\r', '\t', '.', ',', ':', ';', '(', ')', '[', ']', '{', '}', '/', '\\', '-', '_', '!', '?' },
            StringSplitOptions.RemoveEmptyEntries).Where(w => w.Length > 1).ToList();
}
```

---

## 五、Curator 整理机制

### 触发

```csharp
// EnsureL0 尾部，检查是否需要 curator
int coldCount = CountColdEntries();
int daysSinceLast = DaysSinceLastCurator();
if (coldCount > 200 || daysSinceLast > 14)
{
    text += $"\n[系统] 冷知识库: {coldCount} 条 / {daysSinceLast} 天未整理。" +
            "建议说「整理冷知识」触发 curator_review。";
}
```

### curator_review 工具流程

```
1. 扫描冷归档所有条目
2. 标记 [obsolete]（已过时的）
3. 合并 hits > 3 且 category 相同的条目 → 写入 LESSONS.md（热）
4. 合并 category 相同且内容高度相似的 → 保留最新，旧条目标记 merged
5. 合并后原始条目仍保留在冷归档（追加尾部，标记 merged-to: LESSONS.md）
6. 超 365 天的条目 → 移入 LESSONS_archive/{year}/，冷归档清空
7. 输出整理报告：
   "整理完成: 2 条升级到 LESSONS.md, 3 条合并, 1 条标记过时, 15 条归档到 2025/"
```

---

## 六、新增工具汇总

| 工具 | 文件 | 参数 | 说明 |
|------|------|------|------|
| `archive_search` | IOCat | query, max_results(3) | BM25 搜索冷归档，返回匹配片段 |
| `memory_add` | IOCat | content, category | 追加 MEMORY.md，自动去重，超容量时提示 |
| `memory_remove` | IOCat | old_text | 删除 MEMORY.md 条目 |
| `lesson_capture` | IOCat | title, content, source | 冷归档写入（带 BM25 去重 + 时间戳） |
| `growth_record` | BackendHost | action, content | 记录角色成长（milestone/preference/tone），需确认 |
| `curator_review` | BackendHost | — | 整理冷归档，合并+标记+升级+分拆 |
| `knowledge_read` | IOCat | file, query(可选) | 前端用：读取知识文件，可选搜索 |

---

## 七、前端管理界面

### 设置页新增 Tab：「知识管理」

```
┌─ 知识管理 ───────────────────────────────────────────┐
│                                                      │
│  [热存储]           [冷归档]          [进化时间线]      │
│                                                      │
│  ┌─ MEMORY.md (1.2K/2K) ────────────────────────┐    │
│  │ 搜索: [_______________]                       │    │
│  │                                               │    │
│  │ § 技术栈: WPF/C#/Python · 2026-07-08     [✏️] [🗑] │    │
│  │ § 项目: RanParty 自进化开发 · 2026-07-08 [✏️] [🗑] │    │
│  │ § 称呼: 叫"你" · 2026-07-08            [✏️] [🗑] │    │
│  │                                               │    │
│  │ [+ 添加条目]                                   │    │
│  └───────────────────────────────────────────────┘    │
│                                                      │
│  ┌─ LESSONS.md (0.8K/3K) ───────────────────────┐    │
│  │ ...类似布局...                                  │    │
│  └───────────────────────────────────────────────┘    │
│                                                      │
│  ┌─ LESSONS_archive.md (47 条, 最近: 2026-07-08) ─┐  │
│  │ 搜索: [_______________] [🔍]                    │    │
│  │                                               │    │
│  │ [2026-07-08] dotnet publish...        hits:2   │    │
│  │ [2026-07-01] Shell OOM 解决...        hits:3 ⬆ │    │
│  │ [2026-06-20] [obsolete] .NET 6...     hits:1   │    │
│  │                                               │    │
│  │ [触发 Curator 整理]  [导出]                     │    │
│  └───────────────────────────────────────────────┘    │
│                                                      │
│  ┌─ 进化时间线 ──────────────────────────────────┐    │
│  │ 2026-07-08  猫娘: 关系里程碑+1                 │    │
│  │ 2026-07-05  MEMORY: 新增"深夜偏好"             │    │
│  │ 2026-07-03  LESSONS: 升级"dotnet打包"到热存储   │    │
│  │ 2026-06-25  猫娘: 成长轨迹创建                 │    │
│  └───────────────────────────────────────────────┘    │
└──────────────────────────────────────────────────────┘
```

### IPC 接口（新增 3 个方法）

| 方法 | 方向 | 说明 |
|------|------|------|
| `knowledge.list` | 前端→后端 | 读取全部知识文件内容 |
| `knowledge.update` | 前端→后端 | 编辑/删除指定条目 |
| `knowledge.search` | 前端→后端 | 搜索冷热知识（调 archive_search） |

---

## 八、文件清单（新增）

| 文件 | 初始内容 | 注入 | 说明 |
|------|---------|------|------|
| `RanParty/MEMORY.md` | 空模板 | ✅ | 热用户画像，AI 写入 |
| `RanParty/LESSONS.md` | 空模板 | ✅ | 热经验精华，AI 写入 |
| `RanParty/_search_index.md` | 空模板 | ✅ | 冷存储关键词索引 |
| `RanParty/MEMORY_archive.md` | 空，按需创建 | ❌ | 偏好变迁史，去重追加 |
| `RanParty/LESSONS_archive.md` | 空，按需创建 | ❌ | 踩坑留档，去重追加 |
| `RanParty/Characters/{name}_growth.md` | 空模板 | ✅ | 角色成长轨迹 |
| `RanParty/.curator_state` | `{}` | ❌ | Curator 运行状态 |

---

## 九、实现步骤

| 步骤 | 内容 | 文件 | 复杂度 |
|------|------|------|--------|
| 1 | BM25 工具类 | `Core/Bm25.cs` (新) | 低 |
| 2 | IOCat 新增 archive_search, memory_add, memory_remove, lesson_capture, knowledge_read | `Cats/Cats.cs` | 中 |
| 3 | BackendHost 新增 growth_record, curator_review 元工具 | `backend/BackendHost.cs` | 中 |
| 4 | BuildToolsSchema 注册新工具 | `backend/BackendHost.cs` | 低 |
| 5 | EnsureL0 注入 evolution 文件 + curator 触发提示 | `backend/BackendHost.cs` | 低 |
| 6 | 前端 IPC: knowledge.list / update / search | `backend/BackendHost.cs` + 前端 | 中 |
| 7 | RoundTripAsync 尾部：反思触发 + 冷归档容量检查 | `backend/BackendHost.cs` | 低 |
| 8 | 种子文件: MEMORY.md, LESSONS.md, _search_index.md, growth.md 模板 | `RanParty/` | 低 |
| 9 | 前端 UI: 知识管理 Tab | electron/src/ | 高 |
| 10 | AGENTS.md 追加自进化规则 | `RanParty/AGENTS.md` | 低 |
| 11 | TOOL.md 更新工具表 | `RanParty/TOOL.md` | 低 |
| 12 | 打包验证 | — | 低 |
