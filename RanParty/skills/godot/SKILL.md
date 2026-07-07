---
name: Godot 引擎
description: Godot 游戏引擎开发经验
---
# Godot.md — Godot 引擎

> 版本：0.3-public | 2026-07-02
> 类别：L2-Exp

---

## 一、工具定位

Godot 4.6 C# 版本，作为外观层替代 Unity 的渲染/输入/音频/UI 方案。核心逻辑层仍使用独立 C# Core（不依赖 Godot API）。

## 二、部署/接入

**前置条件：** 从 godotengine.org 下载 `.NET` 版本（非标准版）+ .NET SDK 8+ + Visual Studio 2022

**配置步骤：**
1. 安装 .NET SDK 8+
2. 安装 Visual Studio 2022（.NET 桌面开发 workload）
3. Godot Editor → Editor Settings → Dotnet → Editor → Visual Studio 2022
4. 新建 C# 脚本附加到 Node，确认 `GD.Print` 输出到控制台
5. VS2022 配置调试：新建 Executable 启动配置指向 Godot 编辑器 exe

**注意事项：**
- C# 项目无法导出 Web（HTML5），Windows 桌面无影响
- Godot 自带编辑器无 C# 智能提示，必须外接 IDE
- `.godot/mono` 加入 VCS ignore

## 三、核心操作

### 架构对照（Unity vs Godot）

| 维度 | Unity | Godot |
|------|-------|-------|
| 帧回调 | MonoBehaviour.Update | Node._Process(double) |
| 输入 | Input.GetAxisRaw | Input.GetAxis |
| 2D 坐标 | 正交相机 + PPU | 原生 2D，1:1 像素映射 |
| 自定义导入 | ScriptedImporter | FileAccess 运行时读 |
| 调试绘制 | OnRenderObject + GL | _Draw() + CanvasItem |
| 场景切换 | SceneManager | SceneTree + .tscn |
| 资源打包 | AssetBundle | PCK 文件 |

### 外观层帧循环（与 Core 解耦）

```csharp
public override void _Process(double delta)
{
    WriteInputToCommand();    // 输入 → C_Command
    ReadDisplayFromCore();    // C_Core → UI/精灵/音频
}
```

### 文件 IO（优先 C# 原生）

```csharp
// 存档（持久路径）
string saveDir = OS.GetUserDataDir();
string savePath = Path.Combine(saveDir, "save.sav");
File.WriteAllText(savePath, data, Encoding.UTF8);

// 地图文件（项目资源路径）
using var file = FileAccess.Open("res://maps/area_01.map", FileAccess.ModeFlags.Read);
string mapData = file.GetAsText();
```

### 手动绘制（替代 Unity GL）

```csharp
public partial class DebugDrawer : Node2D
{
    public override void _Draw()
    {
        DrawLine(V2.Zero, new V2(100, 0), Colors.Red, 2f);
        DrawRect(new Rect2(50, 50, 30, 30), Colors.Green, false, 1f);
    }
    public override void _Process(double delta) => QueueRedraw();
}
```

### 导出 Windows 包
项目 → 导出 → 添加 Windows Desktop → 配置 → 导出项目 → 生成 `.exe` + `.pck`

## 四、踩坑记录

| 问题 | 说明 | 对策 |
|------|------|------|
| 无 ScriptedImporter | 自定义格式不能自动导入 | 用 `FileAccess` 运行时读取 |
| C# 类名必须匹配文件名 | 重命名时需同时改文件名 | 编辑器外改名需手动同步 |
| _Process(delta) 是 double | delta 是 double 不是 float | 存为 float 时显式转换 `(float)delta` |
| 无内置 AB | 资源更新需自己实现 | PCK 热加载替代（`ProjectSettings.LoadResourcePack`）|
