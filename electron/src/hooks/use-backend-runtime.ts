import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react'
import type { ApprovalRequest, Bootstrap, ClarificationRequest, ElicitationRequest, PetState, Session, Settings, ThreadEvent, ThreadItem, ToolResultItem } from '../types'
import { internalToolNotice, isInternalToolName, toThreadItems } from '../types'
import { normalizeBackendEvent } from '../state/backend-events'
import { genId, mergePendingQueues, planVersionOf, preserveKnownPlan, removeTurnPending, type ItemMap, type PlanVersion } from '../state/session-runtime'
import { applyThreadEvent, approvalId, clarificationId, enqueuePending, reconcileSessionSnapshot, removeSessionPending, type PendingBySession } from '../state/thread-state'

interface BackendRuntimeOptions {
  setRightOpen: Dispatch<SetStateAction<boolean>>
}

export interface BackendRuntime {
  sessions: Session[]
  setSessions: Dispatch<SetStateAction<Session[]>>
  settings: Settings | null
  petState: PetState
  items: ItemMap
  activeId: string
  setActiveId: Dispatch<SetStateAction<string>>
  approvals: PendingBySession<ApprovalRequest>
  setApprovals: Dispatch<SetStateAction<PendingBySession<ApprovalRequest>>>
  clarifications: PendingBySession<ClarificationRequest>
  setClarifications: Dispatch<SetStateAction<PendingBySession<ClarificationRequest>>>
  elicitations: ElicitationRequest[]
  setElicitations: Dispatch<SetStateAction<ElicitationRequest[]>>
  loading: boolean
  error: string
  setError: Dispatch<SetStateAction<string>>
  appendItem: (sessionId: string, item: ThreadItem) => void
  adoptSession: (session: Session) => void
}

export function useBackendRuntime({ setRightOpen }: BackendRuntimeOptions): BackendRuntime {
  const [sessions, setSessions] = useState<Session[]>([])
  const [settings, setSettings] = useState<Settings | null>(null)
  const [petState, setPetState] = useState<PetState>({ settings: { enabled: false, activePetId: '', scale: 0.62 }, pets: [] })
  const [items, setItems] = useState<ItemMap>({})
  const [activeId, setActiveId] = useState('')
  const [approvals, setApprovals] = useState<PendingBySession<ApprovalRequest>>({})
  const [clarifications, setClarifications] = useState<PendingBySession<ClarificationRequest>>({})
  const [elicitations, setElicitations] = useState<ElicitationRequest[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const activeIdRef = useRef(activeId)
  activeIdRef.current = activeId

  const appendItem = (sessionId: string, item: ThreadItem) => {
    setItems((current) => ({ ...current, [sessionId]: [...(current[sessionId] ?? []), item] }))
  }
  const adoptSession = (session: Session) => {
    const next = { ...session, messages: session.messages ?? [] }
    setSessions((current) => [next, ...current.filter((candidate) => candidate.id !== next.id)])
    setItems((current) => ({ ...current, [next.id]: reconcileSessionSnapshot(current[next.id] ?? [], toThreadItems(next.messages), next.busy) }))
    setActiveId(next.id)
  }

  useEffect(() => {
    let disposed = false
    let bootstrapEpoch = 0
    let lastEventSequence = 0
    let staleBootstrapRetries = 0
    let planVersions: Record<string, PlanVersion> = {}
    const seenEventIds = new Set<string>()

    const applyEvent = (event: ThreadEvent & { sessionId: string }) => {
      setItems((current) => ({ ...current, [event.sessionId]: applyThreadEvent(current[event.sessionId] ?? [], event, genId) }))
    }
    const append = (sessionId: string, item: ThreadItem) => {
      setItems((current) => ({ ...current, [sessionId]: [...(current[sessionId] ?? []), item] }))
    }
    const updateTool = (sessionId: string, name: string, runId: string, updater: (item: ToolResultItem) => ToolResultItem) => {
      setItems((current) => {
        const list = [...(current[sessionId] ?? [])]
        const exactIndex = runId ? list.findIndex((item) => item.type === 'tool_result' && item.toolCallId === runId) : -1
        const index = exactIndex >= 0 ? exactIndex : list.findLastIndex((item) => item.type === 'tool_result' && item.toolName === name && item.status === 'in_progress')
        const item = list[index]
        if (item?.type === 'tool_result') list[index] = updater(item)
        return { ...current, [sessionId]: list }
      })
    }
    const refreshBootstrap = async () => {
      const epoch = ++bootstrapEpoch
      try {
        const result = await window.ranparty.request<Bootstrap>('app.bootstrap')
        if (disposed || epoch !== bootstrapEpoch) return
        const responseCursor = Number(result.eventCursor ?? 0)
        if (!Number.isSafeInteger(responseCursor) || responseCursor < 0) throw new Error('app.bootstrap returned an invalid event cursor')
        if (responseCursor < lastEventSequence) {
          staleBootstrapRetries++
          if (staleBootstrapRetries <= 2) void refreshBootstrap()
          else setError('应用状态连续三次未能同步，请稍后重试。')
          return
        }
        staleBootstrapRetries = 0
        const guardedSessions = result.sessions.map((snapshot) => preserveKnownPlan(snapshot, planVersions[snapshot.id]))
        const nextVersions: Record<string, PlanVersion> = {}
        for (const session of guardedSessions) {
          const entry = planVersionOf(session)
          if (entry) nextVersions[entry[0]] = entry[1]
        }
        planVersions = nextVersions
        lastEventSequence = Math.max(lastEventSequence, responseCursor)
        setSessions(guardedSessions)
        setSettings({ ...result.settings, permissionProfile: result.settings.permissionProfile ?? ':workspace' })
        setPetState(result.petState ?? { settings: { enabled: false, activePetId: '', scale: 0.62 }, pets: [] })
        setApprovals((current) => mergePendingQueues(current, result.pendingApprovals ?? [], approvalId))
        setClarifications((current) => mergePendingQueues(current, result.pendingClarifications ?? [], clarificationId))
        setElicitations(result.pendingElicitations ?? [])
        setItems((current) => Object.fromEntries(result.sessions.map((session) => [session.id, reconcileSessionSnapshot(current[session.id] ?? [], toThreadItems(session.messages ?? []), session.busy)])))
        setActiveId((current) => result.sessions.some((session) => session.id === current) ? current : result.sessions[0]?.id || '')
        setError('')
      } catch (reason) {
        if (!disposed && epoch === bootstrapEpoch) setError(messageOf(reason))
      } finally {
        if (!disposed && epoch === bootstrapEpoch) setLoading(false)
      }
    }
    const handleThreadEvent = (event: ThreadEvent) => {
      switch (event.type) {
        case 'session.created': {
          const session = { ...event.session, messages: event.session.messages ?? [] }
          const version = planVersionOf(session)
          if (version) planVersions[session.id] = version[1]
          else delete planVersions[session.id]
          setSessions((current) => [session, ...current.filter((candidate) => candidate.id !== session.id)])
          setItems((current) => ({ ...current, [session.id]: toThreadItems(session.messages) }))
          setActiveId(session.id)
          break
        }
        case 'session.deleted':
          delete planVersions[event.sessionId]
          setSessions((current) => current.filter((session) => session.id !== event.sessionId))
          setItems((current) => { const next = { ...current }; delete next[event.sessionId]; return next })
          setApprovals((current) => removeSessionPending(current, event.sessionId))
          setClarifications((current) => removeSessionPending(current, event.sessionId))
          setActiveId((current) => current === event.sessionId ? '' : current)
          break
        case 'session.updated': {
          const update = preserveKnownPlan(event.session, planVersions[event.session.id])
          const version = planVersionOf(update)
          if (version) planVersions[update.id] = version[1]
          else delete planVersions[update.id]
          setSessions((current) => current.map((session) => session.id === update.id ? { ...update, messages: session.messages } : session))
          if (!update.busy && update.messages) {
            setItems((current) => ({ ...current, [update.id]: reconcileSessionSnapshot(current[update.id] ?? [], toThreadItems(update.messages), false) }))
            const completedTurnId = update.activeTurnId
            if (completedTurnId) {
              setApprovals((current) => removeTurnPending(current, update.id, completedTurnId))
              setClarifications((current) => removeTurnPending(current, update.id, completedTurnId))
            }
          }
          break
        }
        case 'settings.changed':
          setSettings((current) => current ? { ...event.settings, permissionProfile: current.permissionProfile } : event.settings)
          break
        case 'skills.changed':
          window.dispatchEvent(new CustomEvent('ranparty:skills-changed'))
          break
        case 'pet.changed':
          setPetState(event.petState)
          break
        case 'message.added': case 'assistant.started': case 'assistant.delta': case 'assistant.reasoning': case 'assistant.completed': case 'run.budget':
          applyEvent(event)
          break
        case 'plan.updated': {
          const planId = event.planId?.trim() ?? ''
          const revision = event.revision ?? 0
          const current = planVersions[event.sessionId]
          if (!planId || revision < 1 || (current && (current.planId !== planId || revision < current.revision))) break
          planVersions[event.sessionId] = { planId, revision }
          setSessions((sessions) => sessions.map((session) => session.id === event.sessionId ? { ...session, planId, planRevision: revision } : session))
          applyEvent(event)
          break
        }
        case 'turn.state': {
          const busy = isBusyState(event.state)
          setSessions((sessions) => sessions.map((session) => session.id !== event.sessionId || (isTerminalState(event.state) && session.activeTurnId && session.activeTurnId !== event.turnId) ? session : { ...session, activeTurnId: event.turnId, turnState: event.state, busy }))
          applyEvent(event)
          if (!busy) {
            setApprovals((current) => removeTurnPending(current, event.sessionId, event.turnId))
            setClarifications((current) => removeTurnPending(current, event.sessionId, event.turnId))
          }
          break
        }
        case 'turn.retrying':
          setSessions((sessions) => sessions.map((session) => session.id === event.sessionId ? { ...session, activeTurnId: event.turnId, turnState: 'retrying', busy: true } : session))
          applyEvent(event)
          break
        case 'chat.completed': case 'chat.cancelled':
          applyEvent(event)
          if (event.turnId) {
            const turnId = event.turnId
            setApprovals((current) => removeTurnPending(current, event.sessionId, turnId))
            setClarifications((current) => removeTurnPending(current, event.sessionId, turnId))
          }
          break
        case 'chat.error': {
          if (event.sessionId === activeIdRef.current) setError(String(event.message ?? '模型请求失败'))
          applyEvent(event)
          if (event.turnId) {
            const turnId = event.turnId
            setApprovals((current) => removeTurnPending(current, event.sessionId, turnId))
            setClarifications((current) => removeTurnPending(current, event.sessionId, turnId))
          }
          break
        }
        case 'tool.started': {
          const name = String(event.name ?? '')
          setItems((current) => ({ ...current, [event.sessionId]: markLatestAssistantToolCall(current[event.sessionId] ?? [], event.turnId) }))
          if (!isInternalToolName(name)) applyEvent(event)
          break
        }
        case 'tool.completed': {
          const name = String(event.name ?? '')
          if (isInternalToolName(name)) append(event.sessionId, { type: 'system_notice', id: genId('internal'), status: event.isError ? 'failed' : 'completed', content: internalToolNotice(name, String(event.content ?? '')) })
          else applyEvent(event)
          if (!isInternalToolName(name) && String(event.path ?? '').trim() && event.sessionId === activeIdRef.current) setRightOpen(true)
          break
        }
        case 'approval.requested': setApprovals((current) => enqueuePending(current, event.approval, approvalId)); break
        case 'clarification.requested': setClarifications((current) => enqueuePending(current, event.clarification, clarificationId)); break
        case 'internal.notice': append(event.sessionId, { type: 'system_notice', id: genId('internal'), status: 'completed', content: event.content }); break
        case 'backend.error': setError(String(event.message ?? '')); break
        case 'backend.exited': setError(`后端异常退出 (code: ${event.code ?? 'unknown'})`); break
        case 'context.compacted': break
      }
    }
    const unsubscribe = window.ranparty.onEvent((eventName, data) => {
      const record = recordOf(data)
      const sequence = Number(record?.sequence ?? 0)
      if (Number.isSafeInteger(sequence) && sequence > 0) {
        if (lastEventSequence > 0 && sequence > lastEventSequence + 1) void refreshBootstrap()
        lastEventSequence = Math.max(lastEventSequence, sequence)
      }
      const eventId = String(record?.eventId ?? '')
      if (eventId) {
        if (seenEventIds.has(eventId)) return
        seenEventIds.add(eventId)
        if (seenEventIds.size > 5000) seenEventIds.delete(seenEventIds.values().next().value ?? '')
      }
      if (eventName === 'backend.ready') {
        seenEventIds.clear(); lastEventSequence = 0; staleBootstrapRetries = 0; planVersions = {}; setApprovals({}); setClarifications({}); setElicitations([]); void refreshBootstrap(); return
      }
      if (eventName === 'elicitation.requested' && record) {
        const request = record as unknown as ElicitationRequest
        setElicitations((current) => [...current.filter((item) => item.elicitationId !== request.elicitationId), request])
        return
      }
      if (eventName === 'agent.started') { appendAgentStart(record, setItems); return }
      if (eventName === 'agent.completed') {
        const sessionId = String(record?.sessionId ?? '')
        const isError = Boolean(record?.isError)
        updateTool(sessionId, 'delegate_agent', String(record?.agentRunId ?? ''), (item) => ({ ...item, status: isError ? 'failed' : 'completed', content: String(record?.content ?? ''), toolError: isError }))
        return
      }
      if (eventName === 'team.plan') {
        const sessionId = String(record?.sessionId ?? '')
        append(sessionId, { type: 'system_notice', id: genId('team_plan'), status: 'in_progress', turnId: String(record?.turnId ?? ''), content: `专家团队「${String(record?.teamName ?? '未命名团队')}」正在拆解任务并分配成员。` })
        return
      }
      if (eventName === 'team.summary') {
        const sessionId = String(record?.sessionId ?? '')
        append(sessionId, { type: 'system_notice', id: genId('team_summary'), status: 'completed', turnId: String(record?.turnId ?? ''), content: `专家团队「${String(record?.teamName ?? '未命名团队')}」已完成成员协作与汇总。` })
        return
      }
      const event = normalizeBackendEvent(eventName, data)
      if (event) handleThreadEvent(event)
    })
    void refreshBootstrap()
    return () => { disposed = true; bootstrapEpoch++; unsubscribe?.() }
  }, [setRightOpen])

  return { sessions, setSessions, settings, petState, items, activeId, setActiveId, approvals, setApprovals, clarifications, setClarifications, elicitations, setElicitations, loading, error, setError, appendItem, adoptSession }
}

function messageOf(reason: unknown) { return reason instanceof Error ? reason.message : String(reason) }
function isBusyState(state: Session['turnState']) { return state === 'running' || state === 'retrying' || state === 'waiting_approval' || state === 'waiting_clarification' || state === 'cancelling' }
function isTerminalState(state: Session['turnState']) { return state === 'completed' || state === 'cancelled' || state === 'failed' }

function markLatestAssistantToolCall(items: ThreadItem[], turnId?: string) {
  const next = [...items]
  const index = next.findLastIndex((item) => item.type === 'assistant_message' && (!turnId || !item.turnId || item.turnId === turnId))
  const item = next[index]
  if (item?.type === 'assistant_message') next[index] = { ...item, hasToolCalls: true }
  return next
}

function appendAgentStart(data: Record<string, unknown> | undefined, setItems: Dispatch<SetStateAction<ItemMap>>) {
  const sessionId = String(data?.sessionId ?? '')
  const agentName = String(data?.agentName ?? '子 Agent')
  const agentRunId = String(data?.agentRunId ?? '')
  const task = String(data?.task ?? '').slice(0, 80)
  setItems((current) => {
    const list = [...(current[sessionId] ?? [])]
    const exactIndex = agentRunId ? list.findIndex((item) => item.type === 'tool_result' && item.toolCallId === agentRunId) : -1
    const index = exactIndex >= 0 ? exactIndex : list.findLastIndex((item) => item.type === 'tool_result' && item.toolName === 'delegate_agent' && item.status === 'in_progress' && (!item.agentName || item.agentName === agentName))
    const item = list[index]
    if (item?.type === 'tool_result') list[index] = { ...item, content: task || '正在处理子任务', agentName }
    else list.push({ type: 'tool_result', id: genId('agent'), status: 'in_progress', turnId: String(data?.turnId ?? ''), toolCallId: agentRunId || undefined, toolName: 'delegate_agent', content: task || '正在处理子任务', toolError: false, agentName })
    return { ...current, [sessionId]: list }
  })
}

function recordOf(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}
