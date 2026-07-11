import type {
  AssistantMessageItem,
  ClarificationRequest,
  ErrorItem,
  PlanStepItem,
  SystemNoticeItem,
  ThreadEvent,
  ThreadItem,
  ToolResultItem,
  ApprovalRequest,
} from '../types'
import { toThreadItems } from '../types'

export type PendingBySession<T> = Record<string, T[]>

export function enqueuePending<T extends { sessionId: string }>(
  current: PendingBySession<T>,
  request: T,
  idOf: (value: T) => string,
): PendingBySession<T> {
  const list = current[request.sessionId] ?? []
  if (list.some((item) => idOf(item) === idOf(request))) return current
  return { ...current, [request.sessionId]: [...list, request] }
}

export function dequeuePending<T extends { sessionId: string }>(
  current: PendingBySession<T>,
  sessionId: string,
  id: string,
  idOf: (value: T) => string,
): PendingBySession<T> {
  const nextList = (current[sessionId] ?? []).filter((item) => idOf(item) !== id)
  if (nextList.length > 0) return { ...current, [sessionId]: nextList }
  const next = { ...current }
  delete next[sessionId]
  return next
}

export function removeSessionPending<T>(current: PendingBySession<T>, sessionId: string): PendingBySession<T> {
  if (!(sessionId in current)) return current
  const next = { ...current }
  delete next[sessionId]
  return next
}

export const approvalId = (request: ApprovalRequest) => request.approvalId
export const clarificationId = (request: ClarificationRequest) => request.clarificationId

export function applyThreadEvent(
  current: ThreadItem[],
  event: ThreadEvent,
  makeId: (prefix: string) => string = defaultId,
): ThreadItem[] {
  switch (event.type) {
    case 'message.added': {
      const item = toThreadItems([event.message])[0]
      return item ? [...current, { ...item, id: makeId('msg') }] : current
    }
    case 'assistant.started':
      return upsertAssistant(current, event.messageId, event.turnId, (item) => ({
        ...item,
        status: 'in_progress',
        streaming: true,
      }))
    case 'assistant.delta':
      return upsertAssistant(current, event.messageId, event.turnId, (item) => ({
        ...item,
        content: item.content + String(event.delta ?? ''),
        status: 'in_progress',
        streaming: true,
      }))
    case 'assistant.reasoning':
      return upsertAssistant(current, event.messageId, event.turnId, (item) => ({
        ...item,
        reasoning: (item.reasoning ?? '') + String(event.delta ?? ''),
        status: 'in_progress',
        streaming: true,
      }))
    case 'assistant.completed':
      return upsertAssistant(current, event.messageId, event.turnId, (item) => ({
        ...item,
        content: event.content != null && event.content !== '' ? String(event.content) : item.content,
        status: 'completed',
        streaming: false,
        usageIn: Number(event.usageIn ?? 0),
        usageOut: Number(event.usageOut ?? 0),
        model: String(event.model ?? ''),
      }))
    case 'tool.started':
      return upsertTool(current, event, makeId)
    case 'tool.completed':
      return upsertTool(current, event, makeId)
    case 'plan.updated':
      return upsertPlan(current, event)
    case 'chat.cancelled':
      return finishRunning(current, '已停止生成。', 'cancelled', event.turnId)
    case 'chat.error': {
      const message = String(event.message ?? '模型请求失败')
      const finished = finishRunning(current, message, 'failed', event.turnId)
      if (finished.some((item) => item.type === 'error' && item.message === message)) return finished
      return [...finished, { type: 'error', id: makeId('error'), status: 'failed', turnId: event.turnId, message } satisfies ErrorItem]
    }
    case 'chat.completed':
      return finishRunning(current, '', 'completed', event.turnId)
    case 'turn.state': {
      if (event.state === 'cancelled') return finishTurnNotices(finishRunning(current, '已停止生成。', 'cancelled', event.turnId), event.turnId)
      if (event.state === 'failed') return finishTurnNotices(finishRunning(current, '任务执行失败。', 'failed', event.turnId), event.turnId)
      if (event.state === 'completed') return finishTurnNotices(finishRunning(current, '', 'completed', event.turnId), event.turnId)
      return current
    }
    case 'turn.retrying':
      return upsertSystemNotice(current, `retry_${event.turnId}`, `模型请求失败，正在重试 ${event.attempt}/${event.maxAttempts}（${Math.ceil(event.delayMs / 1000)} 秒后）${event.message ? `：${event.message}` : ''}`, 'in_progress', event.turnId)
    case 'run.budget':
      return upsertSystemNotice(current, `budget_${event.turnId}_${event.kind}`, `本轮任务已触发 ${event.kind} 安全预算，将基于已有进展收尾。`, 'completed', event.turnId)
    default:
      return current
  }
}

export function reconcileSessionSnapshot(current: ThreadItem[], snapshot: ThreadItem[], busy: boolean) {
  if (snapshot.length === 0) return current
  if (busy) {
    const liveById = new Map(current.map((item) => [item.id, item]))
    const snapshotIds = new Set(snapshot.map((item) => item.id))
    return [
      ...snapshot.map((item) => liveById.get(item.id) ?? item),
      ...current.filter((item) => !snapshotIds.has(item.id)),
    ]
  }
  const signatures = new Set(snapshot.map(itemSignature))
  const terminalLiveItems = current.filter((item) => {
    if (item.id.startsWith('history_')) return false
    if (item.type === 'assistant_message') return !item.streaming && Boolean(item.content.trim())
    return item.type === 'error' || item.type === 'plan_step' || (item.type === 'tool_result' && item.status !== 'in_progress')
  })
  return [...snapshot, ...terminalLiveItems.filter((item) => !signatures.has(itemSignature(item)))]
}

function upsertAssistant(
  current: ThreadItem[],
  messageId: string,
  turnId: string | undefined,
  update: (item: AssistantMessageItem) => AssistantMessageItem,
) {
  const index = current.findIndex((item) => item.id === messageId)
  const base: AssistantMessageItem = index >= 0 && current[index].type === 'assistant_message'
    ? current[index] as AssistantMessageItem
    : { type: 'assistant_message', id: messageId, status: 'in_progress', turnId, content: '', streaming: true }
  const next = update({ ...base, turnId: turnId || base.turnId })
  if (index < 0) return [...current, next]
  return current.map((item, itemIndex) => itemIndex === index ? next : item)
}

function upsertTool(
  current: ThreadItem[],
  event: Extract<ThreadEvent, { type: 'tool.started' | 'tool.completed' }>,
  makeId: (prefix: string) => string,
) {
  const completion = event.type === 'tool.completed' ? event : null
  const callId = String(event.toolCallId ?? '').trim()
  let index = callId
    ? current.findIndex((item) => item.type === 'tool_result' && item.toolCallId === callId)
    : -1
  if (index < 0 && completion) {
    index = current.findLastIndex((item) => item.type === 'tool_result' && item.toolName === String(event.name ?? '') && item.status === 'in_progress')
  }
  const existing = index >= 0 && current[index].type === 'tool_result' ? current[index] as ToolResultItem : undefined
  const item: ToolResultItem = {
    type: 'tool_result',
    id: existing?.id ?? (callId ? `tool_${callId}` : makeId('tool')),
    status: completion ? (completion.isError ? 'failed' : 'completed') : 'in_progress',
    turnId: event.turnId || existing?.turnId,
    toolCallId: callId || existing?.toolCallId,
    toolName: String(event.name ?? existing?.toolName ?? '工具'),
    toolArguments: String(event.arguments ?? existing?.toolArguments ?? ''),
    toolWorkdir: String(event.workdir ?? existing?.toolWorkdir ?? ''),
    content: completion ? String(completion.content ?? '') : existing?.content ?? '',
    toolPath: completion ? String(completion.path ?? '') : existing?.toolPath,
    toolError: completion ? Boolean(completion.isError) : false,
    durationMs: completion ? Number(completion.durationMs ?? 0) || undefined : existing?.durationMs,
    agentName: String(event.agentName ?? existing?.agentName ?? ''),
  }
  if (index < 0) return [...current, item]
  return current.map((value, itemIndex) => itemIndex === index ? item : value)
}

function upsertPlan(current: ThreadItem[], event: Extract<ThreadEvent, { type: 'plan.updated' }>) {
  const id = `plan_${event.planId || event.sessionId}`
  const item: PlanStepItem = {
    type: 'plan_step',
    id,
    status: 'completed',
    turnId: event.turnId,
    steps: event.plan,
    explanation: event.explanation,
    planId: event.planId,
    revision: event.revision,
  }
  const index = current.findIndex((candidate) => candidate.id === id)
  if (index < 0) return [...current, item]
  const existing = current[index]
  if (existing.type === 'plan_step' && (existing.revision ?? 0) > (event.revision ?? 0)) return current
  return current.map((candidate, itemIndex) => itemIndex === index ? item : candidate)
}

function finishRunning(current: ThreadItem[], message: string, terminal: 'completed' | 'failed' | 'cancelled', turnId?: string) {
  return current.map((item) => {
    const sameTurn = !turnId || !item.turnId || item.turnId === turnId
    if (sameTurn && item.type === 'assistant_message' && (item.streaming || item.status === 'in_progress')) {
      return {
        ...item,
        content: item.content || message,
        streaming: false,
        status: terminal,
        error: terminal === 'failed',
      }
    }
    if (sameTurn && item.type === 'tool_result' && item.status === 'in_progress') {
      return {
        ...item,
        content: item.content || message || '任务已结束。',
        status: terminal,
        toolError: terminal === 'failed',
      }
    }
    return item
  })
}

function upsertSystemNotice(current: ThreadItem[], id: string, content: string, status: SystemNoticeItem['status'], turnId?: string) {
  const item: SystemNoticeItem = { type: 'system_notice', id, status, turnId, content }
  const index = current.findIndex((candidate) => candidate.id === id)
  if (index < 0) return [...current, item]
  return current.map((candidate, itemIndex) => itemIndex === index ? item : candidate)
}

function finishTurnNotices(current: ThreadItem[], turnId: string) {
  return current.map((item) => item.type === 'system_notice' && item.id === `retry_${turnId}`
    ? { ...item, status: 'completed' as const }
    : item)
}

function defaultId(prefix: string) {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`
}

function itemSignature(item: ThreadItem) {
  if (item.type === 'assistant_message') return `${item.type}:${item.content}`
  if (item.type === 'error') return `${item.type}:${item.message}`
  if (item.type === 'plan_step') return `${item.type}:${item.explanation ?? ''}:${JSON.stringify(item.steps)}`
  if (item.type === 'tool_result') return `${item.type}:${item.toolCallId ?? item.toolName}:${item.content}:${item.toolPath ?? ''}`
  return `${item.type}:${item.id}`
}
