# AVGEngine.md — AVG 剧本引擎

> 版本：1.3-public | 2026-07-02
> 类别：L2-Skill

---

## 一、使用流程

→ 接到剧本序列化需求（小说原稿 / 剧本文本）

→ **阶段①：分镜切分 + 旁白演出化**
  - 通读全文，按自然断点切分段落
  - 标记六标签：[场景][角色][动作][对话][旁白][系统]
  - 可对话化的旁白→转为角色对话
  - 心理活动直接展示为 [对话]
  - 产出：分镜稿

→ **阶段②：资产清单编译**
  - 遍历分镜稿 + 四类资产映射
  - 背景（WallChange）、角色（ImageIn/Change/Out）、BGM、SFX
  - 资产唯一性约束：同名跨章节使用同一 name
  - 产出：全项目唯一资产清单

→ **阶段③：指令序列化**
  - 分镜标记逐条映射为 AVG 指令
  - 对照资产清单约束命名
  - 填入段落填充模板
  - 产出：合规指令文件

→ **剧本校验**
  - 指令名合法性 / 括号完整性 / 必填参数
  - Flag 引用可达性 / Choose 数量匹配 / Goto 目标存在
  - 变量池引用检查

→ **问题已解决，产出已验证**
  → 发出沉淀请求，对接收工流程

---

## 二、核心规则

### 2.1 引擎三层模型
```
外观层（渲染引擎）        ← 渲染/音频/输入转发
    ↓ Command 静态字段
核心层（状态机）          ← 状态机 + 剧本播放 + 协程
    ↓ 外观层可读字段
调度层（帧控制器）        ← 帧定时器（~17ms/帧）
```

### 2.2 基态与模态
| 基态 | 说明 |
|------|------|
| Menu | 主菜单 |
| Read | 阅读态，剧本播放 |
| Debug | Debug 模式 |

模态：Logs / Review / Console / ReadMenu / LoadGame（栈结构，阻塞基态）

### 2.3 剧情包结构
- `AllStory: Dictionary<string, List<string>>` — Key=包名, Value=指令序列
- `AllStoryFlag: Dictionary<string, Dictionary<int, int>>` — Flag跳转索引
- 指令序列化使用自定义分隔符，每行 7 字段（order, str1, str2, str3, i1, i2, i3）

### 2.4 指令集（22 条）

| 指令 | 功能 |
|------|------|
| Speak | 角色对话 |
| ImageIn/Out/Change | 立绘管理 |
| ImageShake/Move/Back/Rise/Fall | 立绘动作 |
| WallChange | 背景切换 |
| MaskIn/MaskOut | 遮罩过渡 |
| BGMPlay / SFXPlay / VideoPlay | 媒体播放 |
| Wait | 等待帧数 |
| Choose / ChooseMessage | 选项分支 |
| Flag / Goto / Exit | 流程控制 |
| NumberChange / IfBigThan / IfSmallThan | 变量条件 |

### 2.5 剧本语法

**行类型前缀：**
| 前缀 | 含义 |
|------|------|
| 无前缀 | Speak（`角色名：台词` / `角色名(左/中/右)：台词`）|
| `-` | 指令（`-指令关键字 (参数)`）|
| `+` | 流程控制（Flag/Goto/Exit/Choose/NumberChange/IfBigThan/IfSmallThan）|
| `//` 或空行 | 注释，跳过 |

**解析管线：** 过滤注解读入→提出Flag写入索引→逐行解析为指令→写入剧情包

### 2.6 变量池
```csharp
public static Dictionary<string, int> VarPool = new Dictionary<string, int>();
```
- 统一字符串索引
- 道具/好感度/数值状态均走此池
- 存档全量序列化

### 2.7 存档系统
- 6 手动 + 1 AutoSave（每次 Speak 自动）+ 1 QuickSave
- 字段：Version / Project / SaveTime / GameTime / StoryData / OrderData / NameData / IntData / VarPool

### 2.8 场景路由
- 跨包跳转：Goto 目标为其他剧情包 Key → 切换当前播放包
- 场景路由在 AllStory 字典中统一管理

---

## 三、行为准则

- **一句一段** — 每个 Speak / 指令 / Flag 独占一行，不多句合并
- **有视觉就写指令** — 场景出现描写必须映射到 WallChange/ImageIn
- **有音效就写播放** — 原文提到声音就插 SFXPlay/BGMPlay
- **叙述性旁白统一归 narrator** — Speak 的角色字段统一或置空
- **所有分支走 Choose+Flag 路由** — 不允许直接 Goto 写死
- **所有数值状态走变量池** — 不允许硬编码判断
- **稿件开头必先定义场景** — 每个剧情包第一行必须是场景定义
- **资产唯一性** — 同一角色/场景在不同章节出现用同一 name，表情变体用 `_表情名` 后缀
- **不追加补充文件** — 阶段性资产补充直接写在原清单末尾

---

## 四、工具索引

**关联 L2-Skill：**
- `CSharp.md` — C# 引擎编码约定

**关联 L2-Exp：**
- `Unity.md` / `Godot.md` — 外观层渲染/音频/输入方案

---

_版本 1.3-public | 2026-07-02 — 脱敏公开版：移除项目引用，保留 AVG 引擎通用架构。_
