# RanParty 客户端架构

## 正式 Electron 运行链路

```text
electron/main.ts
  ├─ 创建桌面窗口、文件选择框
  ├─ 启动 resources/backend/RanParty.Backend.exe
  └─ 通过 preload.cts 暴露受限 IPC
          ↓ JSON Lines
backend/BackendHost.cs
  ├─ 会话、模型配置、角色卡、Skill 与审批协议
  ├─ Core/：模型 API、配置和会话持久化
  ├─ Cats/：文件及 Shell 工具注册与调度
  └─ Tools/：Excel、Word、Markdown 实现
```

- `electron/src/`：当前正式 React 客户端。`mockBridge.ts` 仅供开发浏览器预览，不会代替打包后的 C# 后端。
- `backend/`：Electron 唯一使用的 C# 可执行后端。
- `Core/ApiClient.cs`、`Config.cs`、`Logger.cs`、`SessionStore.cs`：正式后端正在引用。
- `Cats/Cats.cs`、`Cats/ShellCat.cs` 与 `Tools/`：正式后端正在引用。
- `Config/` 和 `RanParty/`：首次启动时复制到用户数据目录的可编辑种子数据，不是废弃代码。
- `RanParty/SOUL.md` 与 `RanParty/Characters/*.md` 是互斥角色来源；`AGENTS.md`、`TOOL.md`、`HUB.md` 作为共同运行规则加载。

## 不参与正式 Electron 构建

以下内容当前不会被 `backend/RanParty.Backend.csproj` 或 Electron 打包入口引用：

- `Program.cs`、`RanParty.csproj`：旧 WinForms 客户端入口和工程。
- `Ui/`：旧 WinForms 主窗体、会话控件和审批窗口。
- `Debug/FDebug.cs`、`Debug/FLog.cs`：旧 WinForms 调试窗口；`Debug/DebugPipe.cs` 仍被后端引用，不能一起删除。
- `Cats/QQBot.cs`：旧 QQ Bot 集成，当前正式后端未编译。
- `design/*.png`：设计参考图，仅供开发查看。

这些文件属于“遗留但保留”，不是运行时依赖。确认不再维护 WinForms 与 QQ Bot 后，可以单独提交一次删除，避免功能改动和历史清理混在同一版本。

## 生成物与缓存

以下目录或文件不应提交，也不应作为源码维护：

- `bin/`、`obj/`
- `backend-publish*/`
- `electron/dist/`、`electron/dist-electron/`
- `electron/release*/`
- `electron/node_modules/`
- `*.tsbuildinfo`
- `.dotnet-home/`、`.nuget/`、`.appdata/`

当前交付包由 `electron/package.json` 的 `package` 脚本生成，便携版位于 `electron/release-v7/RanParty-Electron-1.7.0.exe`；桌面快捷方式指向 `electron/release-v7/win-unpacked/RanParty.exe`。
