import type {
  ApprovalRequest,
  ClarificationRequest,
  RawMessage,
  Session,
  Settings,
  ThreadEvent,
} from '../types'

/** Converts the untyped preload event boundary into the renderer's event union. */
export function normalizeBackendEvent(event: string, raw: unknown): ThreadEvent | null {
  const data = recordOf(raw)
  if (!data && event !== 'settings.changed') return null

  switch (event) {
    case 'session.created':
      return isSession(raw) ? { type: 'session.created', session: raw } : null
    case 'session.deleted':
      return { type: 'session.deleted', sessionId: text(data?.sessionId) }
    case 'session.updated':
      return isSession(raw) ? { type: 'session.updated', session: raw } : null
    case 'settings.changed': {
      const settings = raw || data
      return isSettings(settings) ? { type: 'settings.changed', settings } : null
    }
    case 'skills.changed':
      return { type: 'skills.changed' }
    case 'message.added': {
      const message = data?.message || raw
      return isRawMessage(message) ? { type: 'message.added', sessionId: text(data?.sessionId), turnId: text(data?.turnId), message } : null
    }
    case 'assistant.started':
      return messageEvent('assistant.started', data)
    case 'assistant.delta':
      return { ...messageEvent('assistant.delta', data), delta: text(data?.delta) }
    case 'assistant.reasoning':
      return { ...messageEvent('assistant.reasoning', data), delta: text(data?.delta) }
    case 'assistant.completed':
      return { ...messageEvent('assistant.completed', data), content: data?.content, usageIn: data?.usageIn, usageOut: data?.usageOut, model: data?.model }
    case 'turn.state':
      return { type: 'turn.state', sessionId: text(data?.sessionId), turnId: text(data?.turnId), state: normalizeTurnState(data?.state) }
    case 'turn.retrying':
      return { type: 'turn.retrying', sessionId: text(data?.sessionId), turnId: text(data?.turnId), attempt: number(data?.attempt), maxAttempts: number(data?.maxAttempts), delayMs: number(data?.delayMs), message: text(data?.message) }
    case 'run.budget':
      return { type: 'run.budget', sessionId: text(data?.sessionId), turnId: text(data?.turnId), kind: text(data?.kind) || 'limit' }
    case 'chat.completed':
    case 'chat.cancelled':
      return { type: event, sessionId: text(data?.sessionId), turnId: text(data?.turnId) }
    case 'chat.error':
      return { type: 'chat.error', sessionId: text(data?.sessionId), turnId: text(data?.turnId), message: text(data?.message) }
    case 'tool.started':
      return toolEvent('tool.started', data)
    case 'tool.completed':
      return { ...toolEvent('tool.completed', data), content: text(data?.content), path: text(data?.path), isError: Boolean(data?.isError), durationMs: number(data?.durationMs) }
    case 'plan.updated':
      return { type: 'plan.updated', sessionId: text(data?.sessionId), planId: text(data?.planId), revision: number(data?.revision), explanation: text(data?.explanation), plan: Array.isArray(data?.plan) ? data.plan.filter(isPlanStepValue) : [] }
    case 'approval.requested':
      return normalizeApprovalRequest(data)
    case 'clarification.requested':
      return normalizeClarificationRequest(data)
    case 'context.compacted':
      return { type: 'context.compacted', sessionId: text(data?.sessionId), automatic: Boolean(data?.automatic), profileName: text(data?.profileName), contextTokens: number(data?.contextTokens), beforeTokens: number(data?.beforeTokens) }
    case 'internal.notice':
      return { type: 'internal.notice', sessionId: text(data?.sessionId), content: text(data?.content) }
    case 'backend.error':
      return { type: 'backend.error', message: text(data?.message) }
    case 'backend.exited':
      return { type: 'backend.exited', code: typeof data?.code === 'number' ? data.code : undefined }
    default:
      console.warn('Unknown backend event:', event, data)
      return null
  }
}

function messageEvent<T extends 'assistant.started' | 'assistant.delta' | 'assistant.reasoning' | 'assistant.completed'>(type: T, data?: Record<string, unknown>) {
  return { type, sessionId: text(data?.sessionId), turnId: text(data?.turnId), messageId: text(data?.messageId) }
}

function toolEvent<T extends 'tool.started' | 'tool.completed'>(type: T, data?: Record<string, unknown>) {
  return { type, sessionId: text(data?.sessionId), turnId: text(data?.turnId), toolCallId: text(data?.toolCallId ?? data?.callId ?? data?.id), name: text(data?.name), arguments: text(data?.arguments), workdir: text(data?.workdir), agentName: text(data?.agentName) }
}

function normalizeApprovalRequest(data?: Record<string, unknown>): ThreadEvent | null {
  const approvalId = text(data?.approvalId).trim()
  const sessionId = text(data?.sessionId).trim()
  const turnId = text(data?.turnId).trim()
  if (!approvalId || !sessionId || !turnId) return null
  const review = recordOf(data?.autoReview)
  const reviewRisk = review ? riskLevel(review.risk) : undefined
  const permissionProfile = profileName(data?.permissionProfile)
  const approval: ApprovalRequest = {
    approvalId, sessionId, turnId,
    tool: text(data?.tool), command: text(data?.command), workdir: text(data?.workdir), reason: text(data?.reason),
    arguments: data?.arguments,
    risk: typeof data?.risk === 'string' ? data.risk : undefined,
    policyVersion: typeof data?.policyVersion === 'number' ? data.policyVersion : undefined,
    sessionScoped: typeof data?.sessionScoped === 'boolean' ? data.sessionScoped : undefined,
    permissionProfile,
    autoReview: review && reviewRisk ? { risk: reviewRisk, summary: text(review.summary) } : undefined,
    affectedPaths: stringArray(data?.affectedPaths),
  }
  return { type: 'approval.requested', approval }
}

function normalizeClarificationRequest(data?: Record<string, unknown>): ThreadEvent | null {
  const clarificationId = text(data?.clarificationId).trim()
  const sessionId = text(data?.sessionId).trim()
  const turnId = text(data?.turnId).trim()
  if (!clarificationId || !sessionId || !turnId) return null
  const clarification: ClarificationRequest = {
    clarificationId, sessionId, turnId,
    question: text(data?.question),
    context: typeof data?.context === 'string' ? data.context : undefined,
    options: stringArray(data?.options) ?? [],
    multiSelect: Boolean(data?.multiSelect),
  }
  return { type: 'clarification.requested', clarification }
}

function recordOf(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined
}

function text(value: unknown) { return String(value ?? '') }
function number(value: unknown) { return Number(value ?? 0) }

function isPlanStepValue(value: unknown): value is { step: string; status: 'pending' | 'in_progress' | 'completed' } {
  const candidate = recordOf(value)
  return Boolean(candidate && typeof candidate.step === 'string' && (candidate.status === 'pending' || candidate.status === 'in_progress' || candidate.status === 'completed'))
}

function normalizeTurnState(value: unknown): Session['turnState'] {
  const state = text(value) || 'idle'
  if (state === 'running' || state === 'retrying' || state === 'waiting_approval' || state === 'waiting_clarification' || state === 'cancelling' || state === 'completed' || state === 'cancelled' || state === 'failed') return state
  return 'idle'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function isRawMessage(value: unknown): value is RawMessage {
  const data = recordOf(value)
  if (!data || !isRole(data.role)) return false
  if (typeof data.content === 'string') return true
  return Array.isArray(data.content) && data.content.every((part) => {
    const item = recordOf(part)
    return Boolean(item && typeof item.type === 'string')
  })
}

function isSession(value: unknown): value is Session {
  const data = recordOf(value)
  return Boolean(data
    && stringFields(data, ['id', 'title', 'workspace', 'profileName', 'model', 'displayName', 'lastActive'])
    && numberFields(data, ['tokensIn', 'tokensOut', 'contextWindow', 'lastInputTokens', 'contextTokens'])
    && typeof data.busy === 'boolean'
    && (data.approvalMode === 'ask' || data.approvalMode === 'auto')
    && profileName(data.permissionProfile)
    && Array.isArray(data.messages) && data.messages.every(isRawMessage))
}

function isSettings(value: unknown): value is Settings {
  const data = recordOf(value)
  return Boolean(data
    && stringFields(data, ['activeProfileName', 'ioRoots'])
    && numberFields(data, ['contextWindow', 'compactThreshold'])
    && (data.shellMode === 'ask' || data.shellMode === 'auto')
    && profileName(data.permissionProfile)
    && Array.isArray(data.profiles) && data.profiles.every(isProfile))
}

function isProfile(value: unknown) {
  const data = recordOf(value)
  return Boolean(data
    && stringFields(data, ['name', 'baseUrl', 'model', 'characterCard', 'characterDisplayName'])
    && numberFields(data, ['contextWindow', 'maxOutputTokens'])
    && booleanFields(data, ['supportsTools', 'supportsImages', 'supportsReasoning', 'apiKeyConfigured'])
    && (data.provider === 'openai' || data.provider === 'anthropic')
    && (data.wireProtocol === 'chat_completions' || data.wireProtocol === 'responses' || data.wireProtocol === 'anthropic_messages'))
}

function stringFields(data: Record<string, unknown>, fields: string[]) { return fields.every((field) => typeof data[field] === 'string') }
function numberFields(data: Record<string, unknown>, fields: string[]) { return fields.every((field) => typeof data[field] === 'number') }
function booleanFields(data: Record<string, unknown>, fields: string[]) { return fields.every((field) => typeof data[field] === 'boolean') }
function stringArray(value: unknown) { return Array.isArray(value) && value.every((item) => typeof item === 'string') ? value : undefined }
function isRole(value: unknown): value is RawMessage['role'] { return value === 'user' || value === 'assistant' || value === 'tool' || value === 'event' || value === 'system' }
function riskLevel(value: unknown) { return value === 'low' || value === 'medium' || value === 'high' ? value : undefined }
function profileName(value: unknown) { return value === ':read-only' || value === ':workspace' || value === ':danger-full-access' ? value : undefined }
