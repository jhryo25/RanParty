# RanParty Electron — Agent Engineering Guide

> AI agent 操作本仓库的强制性规范。所有规则都是可自动检查或 lint 的。

## 项目架构

```
electron/
├── main.ts          # Electron 主进程：窗口、IPC、子进程生命周期
├── src/
│   ├── App.tsx      # 全局状态、ThreadEvent 分发中枢
│   ├── types.ts     # 类型定义、ThreadItem/ThreadEvent discriminated union
│   ├── hooks/       # Hook 运行时引擎
│   ├── permissions/ # 权限引擎
│   └── components/  # 纯展示组件
├── preload.cts      # contextBridge 暴露安全 API
└── package.json     # 依赖与构建脚本
```

| 层 | 职责 | 禁止 |
|---|---|---|
| `main.ts` | 窗口管理、IPC handler、子进程 spawn/kill | 禁止包含业务逻辑或类型定义 |
| `src/App.tsx` | 全局 state、ThreadEvent 分发、session CRUD | 禁止超过 400 行 |
| `src/components/` | 纯展示，接收 props，emit callback | 禁止直接调 `window.ranparty`，必须通过 props |
| C# 后端 | 通过 `stdin/stdout` JSON 行协议通信 | 渲染进程禁止直接操作文件系统（走 IPC） |

## TypeScript 硬约束

- ❌ `as` 类型断言 → ✅ 用 type guard（`isToolResult()`, `isUserMessage()`）
- ❌ `any` → ✅ `unknown` + 类型收窄
- ❌ `!` 非空断言 → ✅ early guard `if (!x) throw/return`
- ❌ `JSON.parse` 裸调用 → ✅ `try { JSON.parse(...) } catch { ... }`
- ❌ `useEffect` 无 cleanup → ✅ 必须返回 cleanup 函数
- ❌ string event name 匹配 (`if (event === 'xxx')`) → ✅ 用 `ThreadEvent.type` switch-case

## React 规范

- 所有 `useEffect` 必须有 cleanup（清理 timer/listener/fetch）
- `useMemo`/`useCallback` 依赖数组不能遗漏
- 组件 props 用 interface 显式定义，禁止 inline `Props` 或 `type`
- 避免在 render 中创建行内函数/对象作为 prop（触发不必要重渲染）
- 流式渲染的组件必须 `React.memo` 包裹

## 模块大小上限

| 文件类型 | 目标 | 硬上限 |
|---|---|---|
| 组件文件 | 250 LOC | 350 LOC |
| App.tsx | 300 LOC | 400 LOC |
| types.ts | 300 LOC | 500 LOC |
| utility 模块 | 200 LOC | 300 LOC |

超过上限 → 按职责拆分新文件。

## IPC 协议规则

- 命名格式：`domain:action`（`backend:request`, `dialog:directory`, `hook:exec`）
- 所有 IPC handler 必须 try-catch 包裹，错误以 `{ error: string }` 返回
- `ipcMain.handle` 返回值自动 JSON 序列化，禁止返回不可序列化对象
- 渲染进程通过 `window.ranparty` 调用，禁止直接使用 `ipcRenderer`

## 类型系统

- 消息/事件用 `ThreadItem` / `ThreadEvent` discriminated union
- 新增后端事件 → 先在 `types.ts` 添加 `ThreadEvent` variant + `normalizeBackendEvent` 映射
- 新增消息类型 → 添加 `ThreadItem` variant + type guard + `toThreadItems` 转换
- `RawMessage` → `ThreadItem` 转换走 `toThreadItems()`

## 测试策略

```
组件变更       → ≥ 1 集成测试（mock IPC + render）
types.ts 变更  → 单元测试覆盖所有分支
安全/审批逻辑  → 100% 分支覆盖
IPC handler    → 集成测试 + 边界测试
```

- 测试框架：Vitest + jsdom + @testing-library/react
- Mock IPC：使用 `src/test-utils/mock-bridge.ts`
- 测试文件：`src/__tests__/unit/` 或 `src/__tests__/integration/`

## PR 规范

- 非机械变更 ≤ 500 行
- 安全/审批/类型系统变更 ≤ 300 行 + 强制 review
- 每 PR 附带"测试说明"（覆盖了什么场景）
- 涉及 IPC 协议变更 → 需附带前后端联调说明

## 构建与发布

```bash
# 开发
npm run dev          # 启动 Vite + Electron

# 构建
npm run build        # tsc + vite build

# 打包
npm run package      # build + electron-builder --win portable

# 类型检查
npm run typecheck    # tsc -b --pretty false
```

- `electron-builder` 输出到 `release-v7/`
- 打包前确保 `typecheck` 通过
- 后端二进制放 `backend-publish-v4/`（随 electron-builder extraResources 打包）

## 安全底线

- `shell.openPath` 前必须校验文件扩展名白名单（`SAFE_OPEN_EXTENSIONS`）
- `shell.openExternal` 前必须校验 URL scheme（仅 http/https）
- 禁止在新代码中硬编码密钥、token、内部路径
- `webview` 必须 `sandbox=true` + `contextIsolation=true`
- 文件路径遍历：所有路径操作前做归一化 + 边界检查
