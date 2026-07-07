// ============================================================
// RanParty Type System v2 — Discriminated Union Architecture
// 参考 Codex ThreadItem / ThreadEvent 模式设计
// ============================================================

// ---- 基础类型 ----
export type RawContent = string | Array<{ type: string; text?: string; image_url?: { url: string } }>

export interface RawMessage {
  role: 'user' | 'assistant' | 'tool' | 'event' | 'system'
  content: RawContent
  tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }>
  tool_call_id?: string
  name?: string
  arguments?: string
  path?: string
  is_error?: boolean
  plan?: PlanStep[]
  plan_explanation?: string
}

export interface PlanStep {
  step: string
  status: 'pending' | 'in_progress' | 'completed'
}

// ---- Session & 模型配置 (保持向后兼容) ----
export interface Session {
  id: string
  title: string
  workspace: string
  profileName: string
  model: string
  displayName: string
  approvalMode: 'ask' | 'auto'
  permissionProfile: PermissionProfileName
  tokensIn: number
  tokensOut: number
  contextWindow: number
  lastInputTokens: number
  contextTokens: number
  lastActive: string
  busy: boolean
  messages: RawMessage[]
}

export interface Profile {
  name: string
  baseUrl: string
  model: string
  characterCard: string
  characterDisplayName: string
  provider: 'openai' | 'anthropic'
  wireProtocol: 'chat_completions' | 'responses' | 'anthropic_messages'
  supportsTools: boolean
  supportsImages: boolean
  supportsReasoning: boolean
  contextWindow: number
  maxOutputTokens: number
  apiKeyConfigured: boolean
}

export interface Settings {
  activeProfileName: string
  profiles: Profile[]
  ioRoots: string
  shellMode: 'ask' | 'auto'
  contextWindow: number
  compactThreshold: number
  permissionProfile: PermissionProfileName
}

export interface Skill {
  id: string
  name: string
  description: string
  source: string
  pathLabel: string
}

export interface MarketplaceSkill {
  id: string
  slug?: string
  name: string
  description: string
  pluginName: string
  marketplace: string
  publisher: string
  category: string
  version: string
  installed: boolean
  iconUrl?: string
  downloads?: number
  stars?: number
  requiresApiKey?: boolean
  source?: string
}

export interface Attachment { name: string; dataUrl: string; size?: number }
export interface WorkspaceFile { name: string; path: string; relativePath: string; isDirectory: boolean; size: number; lastWrite: string }
export interface FilePreview { path: string; name: string; extension: string; size: number; lastWrite: string; kind: 'html' | 'markdown' | 'text' | 'image' | 'pdf' | 'unsupported' | 'too_large'; content?: string; dataUrl?: string; limit?: number }

export interface Bootstrap {
  sessions: Session[]
  settings: Settings
  tools: string[]
}

export interface ClarificationRequest {
  clarificationId: string
  sessionId: string
  question: string
  context?: string
  options: string[]
  multiSelect: boolean
}

// ============================================================
// ThreadItem — Discriminated Union 体系
// ============================================================

export type ItemStatus = 'pending' | 'in_progress' | 'completed' | 'failed'

interface ThreadItemBase {
  id: string
  status: ItemStatus
}

/** 用户发送的消息 */
export interface UserMessageItem extends ThreadItemBase {
  type: 'user_message'
  content: string
  images?: string[]
}

/** AI 回复的消息 */
export interface AssistantMessageItem extends ThreadItemBase {
  type: 'assistant_message'
  content: string
  reasoning?: string
  streaming?: boolean
  model?: string
  usageIn?: number
  usageOut?: number
  error?: boolean
}

/** 工具调用请求 */
export interface ToolCallItem extends ThreadItemBase {
  type: 'tool_call'
  toolName: string
  toolArguments: string
  agentName?: string
}

/** 工具执行结果 */
export interface ToolResultItem extends ThreadItemBase {
  type: 'tool_result'
  toolName: string
  content: string
  toolPath?: string
  toolError: boolean
  agentName?: string
  /** 关联的 ToolCallItem id，用于追踪调用链 */
  parentCallId?: string
}

/** 文件变更记录 */
export interface FileChangeItem extends ThreadItemBase {
  type: 'file_change'
  path: string
  action: 'create' | 'modify' | 'delete'
}

/** Plan 步骤 */
export interface PlanStepItem extends ThreadItemBase {
  type: 'plan_step'
  steps: PlanStep[]
  explanation?: string
  /** 是否为仅 plan 更新（无实际内容） */
  planUpdate?: boolean
}

/** 错误 */
export interface ErrorItem extends ThreadItemBase {
  type: 'error'
  message: string
  code?: string
}

/** 上下文压缩 */
export interface ContextCompactionItem extends ThreadItemBase {
  type: 'context_compaction'
  tokensBefore: number
  tokensAfter: number
  automatic: boolean
}

/** 系统通知 */
export interface SystemNoticeItem extends ThreadItemBase {
  type: 'system_notice'
  content: string
}

/** 所有 Thread Item 的联合类型 */
export type ThreadItem =
  | UserMessageItem
  | AssistantMessageItem
  | ToolCallItem
  | ToolResultItem
  | FileChangeItem
  | PlanStepItem
  | ErrorItem
  | ContextCompactionItem
  | SystemNoticeItem

// ============================================================
// ThreadEvent — 替代 string event name 的 discriminated union
// ============================================================

export type ThreadEvent =
  | { type: 'session.created'; session: Session }
  | { type: 'session.deleted'; sessionId: string }
  | { type: 'session.updated'; session: Session }
  | { type: 'settings.changed'; settings: Settings }
  | { type: 'message.added'; sessionId: string; message: RawMessage }
  | { type: 'assistant.started'; sessionId: string; messageId: string }
  | { type: 'assistant.delta'; sessionId: string; messageId: string; delta: string }
  | { type: 'assistant.reasoning'; sessionId: string; messageId: string; delta: string }
  | { type: 'assistant.completed'; sessionId: string; messageId: string; content?: unknown; usageIn?: unknown; usageOut?: unknown; model?: unknown }
  | { type: 'chat.cancelled'; sessionId: string }
  | { type: 'chat.error'; sessionId: string; message?: string }
  | { type: 'tool.started'; sessionId: string; name?: string; arguments?: string; agentName?: string }
  | { type: 'tool.completed'; sessionId: string; name?: string; content?: string; path?: string; isError?: boolean; agentName?: string }
  | { type: 'approval.requested'; approval: ApprovalRequest }
  | { type: 'clarification.requested'; clarification: ClarificationRequest }
  | { type: 'context.compacted'; sessionId: string; automatic: boolean; profileName?: string; contextTokens?: number }
  | { type: 'backend.error'; message: string }
  | { type: 'backend.exited'; code?: number }

// ============================================================
// 审批与权限系统 v2
// ============================================================

/** 权限 Profile 名称 */
export type PermissionProfileName =
  | ':read-only'            // 只读
  | ':workspace'            // 工作区读写 + 受限命令
  | ':danger-full-access'   // 全权限

/** 审批决策 — 4 级，替代旧的 reject/allow_once/allow_session */
export type ApprovalDecision =
  | 'reject'                        // 拒绝
  | 'allow_once'                    // 仅本次允许
  | 'allow_session'                 // 本次会话允许
  | 'allow_with_policy_amendment'   // 允许并更新执行策略（记录到 session）

/** 权限 Profile 配置 */
export interface PermissionProfileConfig {
  name: string
  extends?: string              // 继承父 profile
  fileSystem: {
    readRoots: string[]
    writeRoots: string[]
    deniedExtensions: string[]  // 禁止写入的扩展名 (.exe, .dll 等)
  }
  commands: {
    allowedCommands?: string[]   // 命令白名单 (regex)
    deniedCommands?: string[]    // 命令黑名单 (regex)
    requireApproval?: string[]   // 需审批的命令 (regex)
  }
  network: {
    allowedDomains: string[]
    allowAllExternal: boolean
  }
}

export interface ApprovalRequest {
  approvalId: string
  sessionId: string
  tool: string
  command: string
  workdir: string
  reason: string
  /** v2: 当前生效的权限 profile */
  permissionProfile?: PermissionProfileName
  /** v2: Guardian 自动评审结果 */
  autoReview?: {
    risk: 'low' | 'medium' | 'high'
    summary: string
  }
  /** v2: 受影响的文件列表 */
  affectedPaths?: string[]
}

// ============================================================
// Hook 系统
// ============================================================

export type HookEventType =
  | 'session.start'
  | 'user.prompt.submit'
  | 'tool.pre_use'
  | 'tool.post_use'
  | 'approval.requested'
  | 'context.pre_compact'
  | 'context.post_compact'
  | 'subagent.start'
  | 'subagent.stop'

export type HookHandlerType = 'command' | 'prompt' | 'agent'

export interface HookConfig {
  name: string
  event: HookEventType
  matcher?: string          // regex 匹配 tool name
  handler: HookHandlerType
  command?: string           // handler=command 时
  commandWindows?: string    // Windows 专用命令
  prompt?: string            // handler=prompt 时
  timeout: number            // ms
  enabled: boolean
  source: 'builtin' | 'user' | 'project'
  /** hash 信任：首次运行后记录 hash，之后自动信任 */
  trustedHash?: string
}

export type HookOutputAction = 'allow' | 'warn' | 'block' | 'modify' | 'inject_context'

export interface HookOutput {
  action: HookOutputAction
  message?: string
  changes?: Record<string, unknown>
  injectedContext?: string
}

// ============================================================
// 向后兼容：UiMessage (逐步迁移用)
// ============================================================

export interface UiMessage {
  id: string
  role: 'user' | 'assistant' | 'tool' | 'system'
  content: string
  images?: string[]
  reasoning?: string
  streaming?: boolean
  toolName?: string
  toolArguments?: string
  toolPath?: string
  toolError?: boolean
  agentName?: string
  hasToolCalls?: boolean
  usageIn?: number
  usageOut?: number
  model?: string
  error?: boolean
  plan?: PlanStep[]
  planExplanation?: string
  planUpdate?: boolean
}

// ============================================================
// 工具函数
// ============================================================

export function contentText(content: RawContent): string {
  if (content == null || typeof content === 'string') return content ?? ''
  return content.find((item) => item.type === 'text')?.text ?? ''
}

export function contentImages(content: RawContent): string[] {
  if (content == null || typeof content === 'string') return []
  return content.flatMap((item) => item.type === 'image_url' && item.image_url?.url ? [item.image_url.url] : [])
}

function agentNameFromArguments(value = '') {
  try { return String(JSON.parse(value).profileName || '') } catch { return '' }
}

/** 旧版转换（保持向后兼容，逐步废弃） */
export function toUiMessages(messages: RawMessage[]): UiMessage[] {
  return messages.map((message, index) => ({
    id: `history_${index}`,
    role: message.role === 'event' ? 'system' : message.role,
    content: contentText(message.content),
    images: contentImages(message.content),
    toolName: message.role === 'tool' ? (message.name || '工具结果') : undefined,
    toolArguments: message.role === 'tool' ? message.arguments : undefined,
    toolPath: message.role === 'tool' ? message.path : undefined,
    toolError: message.role === 'tool' ? Boolean(message.is_error) : undefined,
    agentName: message.role === 'tool' && message.name === 'delegate_agent' ? agentNameFromArguments(message.arguments) : undefined,
    hasToolCalls: message.role === 'assistant' && Boolean(message.tool_calls?.length),
    plan: message.role === 'tool' && message.name === 'update_plan' ? message.plan : undefined,
    planExplanation: message.role === 'tool' && message.name === 'update_plan' ? message.plan_explanation : undefined,
    planUpdate: message.role === 'assistant' && Boolean(message.tool_calls?.length) && (message.tool_calls?.every((call) => call.function.name === 'update_plan') ?? false),
  }))
}

/** v2: RawMessage[] → ThreadItem[] */
export function toThreadItems(messages: RawMessage[]): ThreadItem[] {
  return messages.map((message, index) => {
    const id = `history_${index}`
    switch (message.role) {
      case 'user':
        return {
          type: 'user_message' as const,
          id,
          status: 'completed' as const,
          content: contentText(message.content),
          images: contentImages(message.content),
        } satisfies UserMessageItem

      case 'assistant': {
        const isPlanUpdate = Boolean(message.tool_calls?.length) &&
          (message.tool_calls?.every((call) => call.function.name === 'update_plan') ?? false)
        if (isPlanUpdate) {
          return {
            type: 'plan_step' as const,
            id,
            status: 'completed' as const,
            steps: [],
            planUpdate: true,
          } satisfies PlanStepItem
        }
        const hasTools = Boolean(message.tool_calls?.length)
        if (hasTools && !contentText(message.content)) {
          return {
            type: 'tool_call' as const,
            id,
            status: 'completed' as const,
            toolName: 'delegate_agent',
            toolArguments: message.tool_calls?.[0]?.function.arguments ?? '',
          } satisfies ToolCallItem
        }
        return {
          type: 'assistant_message' as const,
          id,
          status: 'completed' as const,
          content: contentText(message.content),
        } satisfies AssistantMessageItem
      }

      case 'tool':
        if (message.name === 'update_plan' && message.plan) {
          return {
            type: 'plan_step' as const,
            id,
            status: 'completed' as const,
            steps: message.plan,
            explanation: message.plan_explanation,
          } satisfies PlanStepItem
        }
        return {
          type: 'tool_result' as const,
          id,
          status: message.is_error ? 'failed' as const : 'completed' as const,
          toolName: message.name || '工具结果',
          content: contentText(message.content),
          toolPath: message.path,
          toolError: Boolean(message.is_error),
          agentName: message.name === 'delegate_agent' ? agentNameFromArguments(message.arguments) : undefined,
        } satisfies ToolResultItem

      case 'event':
      case 'system':
        return {
          type: 'system_notice' as const,
          id,
          status: 'completed' as const,
          content: contentText(message.content),
        } satisfies SystemNoticeItem

      default:
        return {
          type: 'error' as const,
          id,
          status: 'failed' as const,
          message: `Unknown message role: ${(message as RawMessage).role}`,
        } satisfies ErrorItem
    }
  })
}

// ============================================================
// Type Guard 函数 — 用于运行时类型收窄
// ============================================================

export function isUserMessage(item: ThreadItem): item is UserMessageItem {
  return item.type === 'user_message'
}
export function isAssistantMessage(item: ThreadItem): item is AssistantMessageItem {
  return item.type === 'assistant_message'
}
export function isToolCall(item: ThreadItem): item is ToolCallItem {
  return item.type === 'tool_call'
}
export function isToolResult(item: ThreadItem): item is ToolResultItem {
  return item.type === 'tool_result'
}
export function isFileChange(item: ThreadItem): item is FileChangeItem {
  return item.type === 'file_change'
}
export function isPlanStep(item: ThreadItem): item is PlanStepItem {
  return item.type === 'plan_step'
}
export function isError(item: ThreadItem): item is ErrorItem {
  return item.type === 'error'
}
export function isContextCompaction(item: ThreadItem): item is ContextCompactionItem {
  return item.type === 'context_compaction'
}
export function isSystemNotice(item: ThreadItem): item is SystemNoticeItem {
  return item.type === 'system_notice'
}
export function hasToolPath(item: ThreadItem): item is ToolResultItem & { toolPath: string } {
  return item.type === 'tool_result' && item.toolPath != null
}

// ============================================================
// 默认权限 Profile 配置
// ============================================================

export const DEFAULT_PERMISSION_PROFILES: Record<PermissionProfileName, PermissionProfileConfig> = {
  ':read-only': {
    name: ':read-only',
    fileSystem: { readRoots: [], writeRoots: [], deniedExtensions: ['.exe', '.dll', '.sys', '.bat', '.cmd', '.ps1', '.vbs', '.msi', '.com'] },
    commands: { allowedCommands: [], deniedCommands: ['.*'], requireApproval: [] },
    network: { allowedDomains: [], allowAllExternal: false },
  },
  ':workspace': {
    name: ':workspace',
    extends: ':read-only',
    fileSystem: { readRoots: [], writeRoots: [], deniedExtensions: ['.exe', '.dll', '.sys', '.bat', '.cmd', '.ps1', '.vbs', '.msi', '.com'] },
    commands: { allowedCommands: ['^(ls|dir|cat|echo|git|npm|node|python|cargo|go|rustc)$'], deniedCommands: ['^rm\\s+-rf', '^del\\s+/F'], requireApproval: ['^git\\s+push', '^npm\\s+publish'] },
    network: { allowedDomains: ['api.github.com', 'registry.npmjs.org'], allowAllExternal: false },
  },
  ':danger-full-access': {
    name: ':danger-full-access',
    fileSystem: { readRoots: [], writeRoots: [], deniedExtensions: [] },
    commands: { allowedCommands: [], deniedCommands: [], requireApproval: ['^rm\\s+-rf', '^del\\s+/F', '^format'] },
    network: { allowedDomains: [], allowAllExternal: true },
  },
}
