# RanParty Electron

正式桌面客户端由 Electron/React 渲染进程和 C# 后端进程组成，两者通过标准输入输出上的 JSON Lines 协议通信。

## 开发

先发布自包含后端：

```powershell
dotnet publish ..\backend\RanParty.Backend.csproj -c Release -r win-x64 --self-contained true -o ..\backend-publish-v2
```

再启动 Electron 开发环境：

```powershell
npm install
npm run dev
```

仅调试 React 界面时可直接启动 Vite；`src/mockBridge.ts` 会提供本地模拟数据。

## 打包

```powershell
npm run package
```

便携版输出到 `release-v2/RanParty-Electron-1.1.0.exe`。打包内容包括自包含 C# 后端、`Config` 和 `RanParty` 种子数据；首次启动会把可编辑数据复制到 Electron 用户数据目录。

## 安全边界

- 渲染进程启用 `contextIsolation`、禁用 Node 集成，并通过受限 preload API 通信。
- 文件工具只能访问当前会话工作区、RanParty 框架目录和用户明确添加的额外授权目录。
- Shell 与 PowerShell 默认使用“每步确认”。
- API Key 只保存在 C# 配置中，React 端只获取“是否已配置”。

完整文件职责与遗留代码清单见 [`docs/client-architecture.md`](../docs/client-architecture.md)。
