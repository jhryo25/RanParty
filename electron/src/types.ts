import { agentNameFromArguments, contentImages, contentText } from './message-content'

// ---- 基础类型 ----
export type RawContent = string | Array<{ type: string; text?: string; image_url?: { url: string } }>

export interface RawMessage {
  role: 'user' | 'assistant' | 'tool' | 'event' | 'system'
  content: RawContent
  messageId?: string
  turnId?: string
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
  references?: SessionReference[]
  profileName: string
  model: string
  displayName: string
  mode?: SessionMode
  goal?: SessionGoal
  approvalMode: 'ask' | 'auto'
  pendingConfig?: Partial<Pick<Session, 'workspace' | 'profileName' | 'model' | 'mode' | 'approvalMode'>>
  permissionProfile: PermissionProfileName
  tokensIn: number
  tokensOut: number
  contextWindow: number
  lastInputTokens: number
  contextTokens: number
  lastActive: string
  busy: boolean
  activeTurnId?: string
  turnState?: 'idle' | 'running' | 'retrying' | 'waiting_approval' | 'waiting_clarification' | 'cancelling' | 'completed' | 'cancelled' | 'failed'
  planId?: string
  planRevision?: number
  messages: RawMessage[]
}

export type SessionMode = 'default' | 'plan' | 'ask' | 'goal'

export interface SessionReference {
  id: string
  title: string
  workspace: string
  lastActive: string
}

export interface SessionGoal {
  text: string
  status: 'active' | 'complete' | 'blocked'
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
  supportsWebSearch?: boolean
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
export interface ExpertDefinition { schemaVersion: 1; id: string; name: string; description: string; skillIds: string[]; source: string; tags?: string[]; scene?: string }
export interface ExpertTeamDefinition { schemaVersion: 1; id: string; name: string; description: string; leaderSkillId: string; memberSkillIds: string[]; maxParallel: number; source: string }
export interface ExpertConversationStart { expertId?: string; teamId?: string; prompt?: string }
export interface ExpertMemberRun { id: string; expertId: string; status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled'; output?: string; error?: string }
export interface ExpertRun { id: string; teamId: string; plan: string; status: ExpertMemberRun['status']; members: ExpertMemberRun[]; summary?: string }

export interface ConnectorConfig {
  id: string
  name: string
  enabled: boolean
  type: 'stdio' | 'http'
  command?: string
  args?: string[]
  cwd?: string
  env?: Record<string, string>
  url?: string
  headers?: Record<string, string>
  enabledTools?: string[]
  disabledTools?: string[]
  approvalMode?: 'ask' | 'auto' | 'deny'
  timeout?: number
  status?: 'not_configured' | 'disconnected' | 'connected' | 'failed'
  lastError?: string
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
  /** Set only when the catalog explicitly marks the publisher or skill as verified. */
  official?: boolean
}

export interface Attachment { name: string; dataUrl: string; size?: number }
export interface SendEnvelope {
  clientMessageId: string
  sessionId: string
  text: string
  imageDataUrls: string[]
  skillIds: string[]
  expertIds: string[]
  expertTeamId?: string
  referencedSessionIds: string[]
}
export interface WorkspaceFile { name: string; path: string; relativePath: string; isDirectory: boolean; size: number; lastWrite: string }
export interface FilePreview { path: string; name: string; extension: string; size: number; lastWrite: string; kind: 'html' | 'markdown' | 'text' | 'image' | 'pdf' | 'unsupported' | 'too_large'; content?: string; dataUrl?: string; limit?: number }

export interface Bootstrap {
  sessions: Session[]
  settings: Settings
  tools: string[]
  eventCursor?: number
  pendingApprovals?: ApprovalRequest[]
  pendingClarifications?: ClarificationRequest[]
}

export interface ClarificationRequest {
  clarificationId: string
  sessionId: string
  turnId: string
  question: string
  context?: string
  options: string[]
  multiSelect: boolean
}

// ============================================================
// ThreadItem — Discriminated Union 体系
// ============================================================

export type ItemStatus = 'pending' | 'in_progress' | 'completed' | 'failed' | 'cancelled'

interface ThreadItemBase {
  id: string
  status: ItemStatus
  turnId?: string
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
  hasToolCalls?: boolean
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
  toolCallId?: string
  toolName: string
  toolArguments?: string
  toolWorkdir?: string
  content: string
  toolPath?: string
  toolError: boolean
  durationMs?: number
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
  planId?: string
  revision?: number
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

export interface ThreadEventMeta {
  eventId?: string
  sequence?: number
  createdAt?: string
  turnId?: string
}

export type ThreadEvent = ThreadEventMeta & (
  | { type: 'session.created'; session: Session }
  | { type: 'session.deleted'; sessionId: string }
  | { type: 'session.updated'; session: Session }
  | { type: 'settings.changed'; settings: Settings }
  | { type: 'skills.changed' }
  | { type: 'message.added'; sessionId: string; message: RawMessage }
  | { type: 'assistant.started'; sessionId: string; messageId: string }
  | { type: 'assistant.delta'; sessionId: string; messageId: string; delta: string }
  | { type: 'assistant.reasoning'; sessionId: string; messageId: string; delta: string }
  | { type: 'assistant.completed'; sessionId: string; messageId: string; content?: unknown; usageIn?: unknown; usageOut?: unknown; model?: unknown }
  | { type: 'turn.state'; sessionId: string; turnId: string; state: Session['turnState'] }
  | { type: 'turn.retrying'; sessionId: string; turnId: string; attempt: number; maxAttempts: number; delayMs: number; message?: string }
  | { type: 'run.budget'; sessionId: string; turnId: string; kind: string }
  | { type: 'chat.completed'; sessionId: string; turnId?: string }
  | { type: 'chat.cancelled'; sessionId: string; turnId?: string }
  | { type: 'chat.error'; sessionId: string; turnId?: string; message?: string }
  | { type: 'tool.started'; sessionId: string; toolCallId?: string; name?: string; arguments?: string; workdir?: string; agentName?: string }
  | { type: 'tool.completed'; sessionId: string; toolCallId?: string; name?: string; arguments?: string; workdir?: string; content?: string; path?: string; isError?: boolean; durationMs?: number; agentName?: string }
  | { type: 'plan.updated'; sessionId: string; planId?: string; revision?: number; explanation?: string; plan: PlanStep[] }
  | { type: 'approval.requested'; approval: ApprovalRequest }
  | { type: 'clarification.requested'; clarification: ClarificationRequest }
  | { type: 'context.compacted'; sessionId: string; automatic: boolean; profileName?: string; beforeTokens?: number; contextTokens?: number }
  | { type: 'internal.notice'; sessionId: string; content: string }
  | { type: 'backend.error'; message: string }
  | { type: 'backend.exited'; code?: number }
)

// ============================================================
// 审批与权限系统 v2
// ============================================================

/** 权限 Profile 名称 */
export type PermissionProfileName =
  | ':read-only'            // 只读
  | ':workspace'            // 工作区读写 + 受限命令
  | ':danger-full-access'   // 全权限

/** 审批决策 — 拒绝、单次允许或当前会话允许 */
export type ApprovalDecision =
  | 'reject'                        // 拒绝
  | 'allow_once'                    // 仅本次允许
  | 'allow_session'                 // 本次会话允许
  | 'allow_always'                  // 永久允许

export interface ApprovalRequest {
  approvalId: string
  sessionId: string
  tool: string
  command: string
  workdir: string
  reason: string
  turnId: string
  arguments?: unknown
  risk?: 'low' | 'medium' | 'high' | 'persistent_data' | string
  policyVersion?: number
  sessionScoped?: boolean
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

/** v2: RawMessage[] → ThreadItem[] */
export function toThreadItems(messages: RawMessage[]): ThreadItem[] {
  return messages.flatMap((message, index) => {
    const id = message.messageId
      || (message.role === 'tool' && message.tool_call_id ? `tool_${message.tool_call_id}` : '')
      || (message.turnId ? `${message.role}_${message.turnId}` : `history_${index}`)
    switch (message.role) {
      case 'user':
        return {
          type: 'user_message' as const,
          id,
          status: 'completed' as const,
          turnId: message.turnId,
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
            turnId: message.turnId,
            steps: [],
            planUpdate: true,
          } satisfies PlanStepItem
        }
        const hasTools = Boolean(message.tool_calls?.length)
        const toolNames = message.tool_calls?.map((call) => call.function.name) ?? []
        const internalOnly = hasTools && toolNames.every(isInternalToolName)
        if (internalOnly && !contentText(message.content)) return []
        if (hasTools && !contentText(message.content)) {
          return {
            type: 'tool_call' as const,
            id,
            status: 'completed' as const,
            turnId: message.turnId,
            toolName: 'delegate_agent',
            toolArguments: message.tool_calls?.[0]?.function.arguments ?? '',
          } satisfies ToolCallItem
        }
        return {
          type: 'assistant_message' as const,
          id,
          status: message.is_error ? 'failed' as const : 'completed' as const,
          turnId: message.turnId,
          content: contentText(message.content),
          error: Boolean(message.is_error),
        } satisfies AssistantMessageItem
      }

      case 'tool':
        if (isInternalToolName(message.name || '')) {
          const content = internalToolNotice(message.name || '', contentText(message.content))
          return {
            type: 'system_notice' as const,
            id,
            status: message.is_error ? 'failed' as const : 'completed' as const,
            turnId: message.turnId,
            content,
          } satisfies SystemNoticeItem
        }
        if (message.name === 'update_plan' && message.plan) {
          return {
            type: 'plan_step' as const,
            id,
            status: 'completed' as const,
            turnId: message.turnId,
            steps: message.plan,
            explanation: message.plan_explanation,
          } satisfies PlanStepItem
        }
        return {
          type: 'tool_result' as const,
          id,
          status: message.is_error ? 'failed' as const : 'completed' as const,
          turnId: message.turnId,
          toolCallId: message.tool_call_id,
          toolName: message.name || '工具结果',
          toolArguments: message.arguments,
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
          turnId: message.turnId,
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

export function isInternalToolName(name = '') {
  return name === 'growth_record' || name === 'memory_add' || name === 'memory_remove' || name === 'lesson_capture'
}

export function internalToolNotice(name = '', content = '') {
  if (name === 'growth_record') {
    const lower = content.toLocaleLowerCase()
    if (lower.includes('preference')) return '已记录偏好'
    if (lower.includes('lesson')) return '已沉淀经验'
    return '已更新角色成长记录'
  }
  if (name === 'lesson_capture') return '已沉淀经验'
  return '已更新记忆'
}

// ============================================================
// Type Guard 函数 — 用于运行时类型收窄
// ============================================================

export {
  hasToolPath,
  isAssistantMessage,
  isContextCompaction,
  isError,
  isFileChange,
  isPlanStep,
  isSystemNotice,
  isToolCall,
  isToolResult,
  isUserMessage,
} from './thread-item-guards'
