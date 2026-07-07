---
name: Unity 引擎
description: Unity 游戏引擎开发经验
---
# Unity.md — Unity 引擎

> 版本：0.3-public | 2026-07-02
> 类别：L2-Exp

---

## 一、工具定位

Unity 外观层方案。负责渲染、音频、输入采集和 UI 呈现，不持有游戏状态。所有状态在 Core 层。

## 二、部署/接入

Unity Hub 安装 + 项目创建。Built-in RP 或 URP 2D 模板。无需 Addressables。

## 三、核心操作

### 外观层-核心层分离模式

```
Core 逻辑层（独立 Timer，17ms）        Unity 外观层（MonoBehaviour.Update）
  C_Physics / C_Battle / …                ↓ 输入采集 → C_Command
       ↓ C_Core public 只读               ↓ 读取 C_Core → 更新场景/UI/音频
       ↓ C_Command 缓冲
```

**铁则：** Unity 层不持有游戏状态。所有状态在 Core 层。

### 资产加载选择

| 途径 | 场景 | 方式 |
|------|------|------|
| Resources.Load | 固定打包资源 | 同步，Editor/运行时一致 |
| StreamingAssets | 外部数据文件 | `Application.streamingAssetsPath + path` |
| AssetBundle | DLC/Mod/更新内容 | 手动管理 + 引用计数 |

**不引入 Addressables**（与 Core 同步帧循环冲突）。

### AssetBundle 手动管理

```csharp
public class ABManager {
    private Dictionary<string, AssetBundle> _cache = new();
    private Dictionary<string, int> _refCount = new();

    public T Load<T>(string abName, string assetName) where T : Object { … }
    public void Unload(string abName) { … }
}
```
引用计数避免反复加载/卸载，不依赖 GC。

### 输入采集（原生 + 手动轮询）

```csharp
void Update() {
    C_Command.Horizontal  = Input.GetAxisRaw("Horizontal");
    C_Command.LightAttack = Input.GetMouseButtonDown(0) ? 1 : 0;
    C_Command.Dodge       = Input.GetKeyDown(KeyCode.Space) ? 1 : 0;
    // 不监听 Input System 的 started/performed/canceled 事件
}
```

### 2.5D 俯视角渲染

| 组件 | 选型 |
|------|------|
| 摄像头 | Orthographic |
| 渲染管线 | Built-in RP 或 URP 2D |
| 后处理 | 可选（Bloom / Vignette） |
| GL 调试 | `OnRenderObject` 中读取物理碰撞体快照 |

### 构建管线

```csharp
// Editor 菜单
[MenuItem("Build/Build AssetBundles")]
static void BuildABs() { … }

[MenuItem("Build/Release Build")]
static void BuildRelease() { … }
```

## 四、踩坑记录

| 问题 | 说明 | 对策 |
|------|------|------|
| Core 定时器与 Unity 生命周期不同步 | Timer 触发时 Unity 可能正在渲染 | 所有 Unity API 只能在 MonoBehaviour 回调中调用 |
| GL 调试只在 Editor 可用 | 发布包中 GL 不可见 | 用 `#if UNITY_EDITOR` 包裹 |
| StreamingAssets 路径移动端不同 | Android 是 jar: URI | 统一用 `Application.streamingAssetsPath` |
| Burst Debug 文件夹 | 每次 Build 产生 `BurstDebugInformation_DoNotShip` | 关掉 Burst AOT Settings 的 Debug / Save Conversions |
