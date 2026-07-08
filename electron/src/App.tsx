import { useEffect, useMemo, useState } from 'react'
import { ApprovalModal } from './components/ApprovalModal'
import { ClarificationCard } from './components/ClarificationCard'
import { Composer } from './components/Composer'
import { NewTaskModal } from './components/NewTaskModal'
import { RightPanel } from './components/RightPanel'
import { SettingsDrawer } from './components/SettingsDrawer'
import { Sidebar } from './components/Sidebar'
import { SkillMarketplace } from './components/SkillMarketplace'
import { Topbar } from './components/Topbar'
import { Transcript } from './components/Transcript'
import { BUILTIN_HOOKS } from './hooks/hook-runtime'
import type {
  ApprovalRequest,
  AssistantMessageItem,
  Bootstrap,
  ClarificationRequest,
  ErrorItem,
  HookConfig,
  RawMessage,
  Session,
  Settings,
  ThreadEvent,
  ThreadItem,
  ToolResultItem,
} from './types'
import { internalToolNotice, isInternalToolName, toThreadItems } from './types'

type ItemMap = Record<string, ThreadItem[]>

export default function App() {
  const [sessions, setSessions] = useState<Session[]>([])
  const [settings, setSettings] = useState<Settings | null>(null)
  const [items, setItems] = useState<ItemMap>({})
  const [activeId, setActiveId] = useState('')
  const [approval, setApproval] = useState<ApprovalRequest | null>(null)
  const [clarification, setClarification] = useState<ClarificationRequest | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const [leftCollapsed, setLeftCollapsed] = useState(false)
  const [rightOpen, setRightOpen] = useState(false)
  const [newTask, setNewTask] = useState<string | null>(null)
  const [skillsOpen, setSkillsOpen] = useState(false)
  const [composerDraft, setComposerDraft] = useState('')

  useMemo<HookConfig[]>(() => [...BUILTIN_HOOKS], [])

  useEffect(() => {
    window.ranparty.onEvent((eventName, data) => {
      const event = normalizeBackendEvent(eventName, data)
      if (event) handleThreadEvent(event)
    })
    window.ranparty.request<Bootstrap>('app.bootstrap')
      .then((result) => {
        setSessions(result.sessions)
        setSettings({ ...result.settings, permissionProfile: result.settings.permissionProfile ?? ':workspace' })
        setItems(Object.fromEntries(result.sessions.map((s) => [s.id, toThreadItems(s.messages ?? [])])))
        setActiveId((current) => current || result.sessions[0]?.id || '')
      })
      .catch((reason) => setError(messageOf(reason)))
      .finally(() => setLoading(false))
  }, [])

  useEffect(() => {
    if (!error) return
    const timer = window.setTimeout(() => setError(''), 5000)
    return () => window.clearTimeout(timer)
  }, [error])

  useEffect(() => {
    const toggle = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'b') {
        event.preventDefault()
        setLeftCollapsed((value) => !value)
      }
    }
    window.addEventListener('keydown', toggle)
    return () => window.removeEventListener('keydown', toggle)
  }, [])

  useEffect(() => {
    if (window.ranparty.isElectron) document.body.classList.add('electron-shell')
    return () => document.body.classList.remove('electron-shell')
  }, [])

  const active = useMemo(() => sessions.find((s) => s.id === activeId) ?? sessions[0], [sessions, activeId])
  const activeDisplayName = useMemo(() => settings?.profiles.find((p) => p.name === active?.profileName)?.characterDisplayName || active?.displayName || 'AI', [settings, active])
  const workspaces = useMemo(() => [...new Set(sessions.map((s) => s.workspace).filter(Boolean))], [sessions])
  const activeItems = active ? items[active.id] ?? [] : []

  const handleThreadEvent = (event: ThreadEvent) => {
    switch (event.type) {
      case 'session.created': {
        const safeSession = { ...event.session, messages: event.session.messages ?? [] }
        setSessions((current) => [safeSession, ...current.filter((s) => s.id !== safeSession.id)])
        setItems((current) => ({ ...current, [safeSession.id]: toThreadItems(safeSession.messages) }))
        setActiveId(safeSession.id)
        break
      }
      case 'session.deleted':
        setSessions((current) => current.filter((s) => s.id !== event.sessionId))
        setItems((current) => { const next = { ...current }; delete next[event.sessionId]; return next })
        setActiveId((current) => current === event.sessionId ? '' : current)
        break
      case 'session.updated': {
        const update = event.session
        setSessions((current) => current.map((s) => s.id === update.id ? { ...update, messages: s.messages } : s))
        break
      }
      case 'settings.changed':
        setSettings((current) => current ? { ...event.settings, permissionProfile: current.permissionProfile } : event.settings)
        break
      case 'skills.changed':
        window.dispatchEvent(new CustomEvent('ranparty:skills-changed'))
        break
      case 'message.added': {
        const item = toThreadItems([event.message])[0]
        if (item) appendItem(event.sessionId, { ...item, id: genId('msg') })
        break
      }
      case 'assistant.started':
        appendItem(event.sessionId, makeAssistantItem(event.messageId, '', true))
        break
      case 'assistant.delta':
      case 'assistant.reasoning':
        updateItem(event.sessionId, event.messageId, (item) => {
          if (item.type !== 'assistant_message') return item
          if (event.type === 'assistant.delta') return { ...item, content: item.content + String(event.delta ?? '') }
          return { ...item, reasoning: (item.reasoning ?? '') + String(event.delta ?? '') }
        })
        break
      case 'assistant.completed':
        updateItem(event.sessionId, event.messageId, (item) => {
          if (item.type !== 'assistant_message') return item
          return {
            ...item,
            content: event.content != null && event.content !== '' ? String(event.content) : item.content,
            status: 'completed' as const,
            streaming: false,
            usageIn: Number(event.usageIn ?? 0),
            usageOut: Number(event.usageOut ?? 0),
            model: String(event.model ?? ''),
          }
        })
        break
      case 'chat.cancelled':
        setItems((current) => ({
          ...current,
          [event.sessionId]: (current[event.sessionId] ?? []).map((item) =>
            item.type === 'assistant_message' && item.streaming
              ? { ...item, content: item.content || '已停止生成。', streaming: false, status: 'completed' as const }
              : item
          ),
        }))
        break
      case 'chat.error': {
        const text = String(event.message ?? '模型请求失败')
        setError(text)
        appendItem(event.sessionId, makeErrorItem(text))
        break
      }
      case 'tool.started': {
        const name = String(event.name ?? '')
        setItems((current) => {
          const list = [...(current[event.sessionId] ?? [])]
          const aiIdx = list.findLastIndex((item) => item.type === 'assistant_message')
          if (aiIdx >= 0) list[aiIdx] = { ...list[aiIdx], hasToolCalls: true } as AssistantMessageItem
          return { ...current, [event.sessionId]: list }
        })
        if (isInternalToolName(name)) break
        appendItem(event.sessionId, {
          type: 'tool_result',
          id: genId('tool'),
          status: 'in_progress',
          toolName: name || '工具',
          content: '',
          toolError: false,
          agentName: String(event.agentName ?? ''),
        } satisfies ToolResultItem)
        break
      }
      case 'tool.completed': {
        const toolName = String(event.name ?? '')
        if (isInternalToolName(toolName)) {
          appendItem(event.sessionId, {
            type: 'system_notice',
            id: genId('internal'),
            status: event.isError ? 'failed' : 'completed',
            content: internalToolNotice(toolName, String(event.content ?? '')),
          })
          break
        }
        updateLastTool(event.sessionId, toolName, (item) => ({
          ...item,
          status: event.isError ? 'failed' as const : 'completed' as const,
          content: String(event.content ?? ''),
          toolPath: String(event.path ?? ''),
          toolError: Boolean(event.isError),
          agentName: String(event.agentName ?? item.agentName ?? ''),
        }))
        if (String(event.path ?? '').trim()) setRightOpen(true)
        break
      }
      case 'approval.requested':
        setApproval(event.approval)
        break
      case 'clarification.requested':
        setClarification(event.clarification)
        break
      case 'context.compacted':
        break
      case 'internal.notice':
        appendItem(event.sessionId, { type: 'system_notice', id: genId('internal'), status: 'completed', content: event.content })
        break
      case 'backend.error':
        setError(String(event.message ?? ''))
        break
      case 'backend.exited':
        setError(`后端异常退出 (code: ${event.code ?? 'unknown'})`)
        break
    }
  }

  const appendItem = (sessionId: string, item: ThreadItem) => {
    setItems((current) => ({ ...current, [sessionId]: [...(current[sessionId] ?? []), item] }))
  }

  const updateItem = (sessionId: string, itemId: string, updater: (item: ThreadItem) => ThreadItem) => {
    setItems((current) => ({
      ...current,
      [sessionId]: (current[sessionId] ?? []).map((item) => item.id === itemId ? updater(item) : item),
    }))
  }

  const updateLastTool = (sessionId: string, name: string, updater: (item: ToolResultItem) => ToolResultItem) => {
    setItems((current) => {
      const list = [...(current[sessionId] ?? [])]
      const idx = list.findLastIndex((item): item is ToolResultItem => item.type === 'tool_result' && item.toolName === name && item.status === 'in_progress')
      if (idx >= 0) list[idx] = updater(list[idx] as ToolResultItem)
      return { ...current, [sessionId]: list }
    })
  }

  const createSession = async (workspace?: string) => { setSkillsOpen(false); setNewTask(workspace ?? '') }

  const createTask = async ({ prompt, workspace, profileName, skillIds }: { prompt: string; workspace: string; profileName: string; skillIds: string[] }) => {
    try {
      const session = await window.ranparty.request<Session>('session.create', { workspace })
      await window.ranparty.request('session.update', { sessionId: session.id, profileName })
      await window.ranparty.request('chat.send', { sessionId: session.id, text: prompt, imageDataUrls: [], skillIds, expertIds: [] })
    } catch (reason) { setError(messageOf(reason)) }
  }

  const updateSession = async (patch: Record<string, unknown>, sessionId = active?.id) => {
    if (!sessionId) return
    setSessions((current) => current.map((session) => session.id === sessionId ? { ...session, ...patch } as Session : session))
    try { await window.ranparty.request('session.update', { sessionId, ...patch }) }
    catch (reason) { setError(messageOf(reason)) }
  }

  const pickWorkspace = async (sessionId = active?.id) => {
    const workspace = await window.ranparty.chooseDirectory()
    if (workspace) await updateSession({ workspace }, sessionId)
  }

  const send = async (text: string, imageDataUrls: string[], skillIds: string[], expertIds: string[] = []) => {
    if (!active) return
    try { await window.ranparty.request('chat.send', { sessionId: active.id, text, imageDataUrls, skillIds, expertIds }) }
    catch (reason) { setError(messageOf(reason)) }
  }

  const deleteSession = async (session: Session) => {
    if (!window.confirm(`确定删除会话"${session.title}"吗？此操作不可撤销。`)) return
    try { await window.ranparty.request('session.delete', { sessionId: session.id }) }
    catch (reason) { setError(messageOf(reason)) }
  }

  const renameSession = async (session: Session) => {
    const title = window.prompt('重命名会话', session.title)?.trim()
    if (title && title !== session.title) await updateSession({ title }, session.id)
  }

  const stop = async () => { if (active) await window.ranparty.request('chat.cancel', { sessionId: active.id }) }

  const compactContext = async (profileName?: string) => {
    if (!active) return
    try { await window.ranparty.request('session.compact', { sessionId: active.id, profileName: profileName || active.profileName }) }
    catch (reason) {
      const text = messageOf(reason)
      setError(text)
      appendItem(active.id, { type: 'system_notice', id: genId('compact_error'), status: 'failed', content: `上下文总结失败：${text}` })
      throw reason instanceof Error ? reason : new Error(text)
    }
  }

  const respondApproval = async (action: 'reject' | 'allow_once' | 'allow_session' | 'allow_with_policy_amendment', feedback = '') => {
    if (!approval) return
    await window.ranparty.request('approval.respond', { approvalId: approval.approvalId, action, feedback })
    setApproval(null)
  }

  const respondClarification = async (text: string, selection: string[]) => {
    if (!clarification) return
    try { await window.ranparty.request('clarification.respond', { clarificationId: clarification.clarificationId, text, selection }) }
    catch (reason) { setError(messageOf(reason)) }
    finally { setClarification(null) }
  }

  const acceptPlan = async (_planText: string) => {
    if (!active) return
    await updateSession({ mode: 'default' }, active.id)
    try { await window.ranparty.request('chat.send', { sessionId: active.id, text: '按上面的计划执行。', imageDataUrls: [], skillIds: [], expertIds: [] }) }
    catch (reason) { setError(messageOf(reason)) }
  }

  const revisePlan = async (planText: string) => {
    await updateSession({ mode: 'plan' })
    setComposerDraft(`请根据下面的计划继续修改，不要执行工具：\n\n${planText}`)
  }

  const cancelPlan = async () => {
    if (!active) return
    appendItem(active.id, { type: 'system_notice', id: genId('plan_cancelled'), status: 'completed', content: '已取消本次计划执行。' })
  }

  const saveSettings = async (payload: Record<string, unknown>) => {
    await window.ranparty.request('settings.save', payload)
  }

  const openPath = async (path: string) => {
    try {
      await window.ranparty.request('path.open', { path })
      setRightOpen(true)
    } catch (reason) { setError(messageOf(reason)) }
  }

  if (loading) return <div className="boot-screen"><span className="empty-mark">RP</span><p>正在启动 RanParty…</p></div>
  if (!active || !settings) return <div className="boot-screen"><p>{error || '没有可用会话'}</p><button className="primary-button" onClick={() => void createSession()}>新建会话</button></div>

  return (
    <div className={`app-shell ${leftCollapsed ? 'left-collapsed' : ''} ${rightOpen && !skillsOpen ? 'right-open' : ''}`}>
      {!leftCollapsed ? <Sidebar sessions={sessions} activeId={active.id} onSelect={(id) => { setActiveId(id); setSkillsOpen(false) }} onCreate={(workspace) => void createSession(workspace)} onRename={(session) => void renameSession(session)} onDelete={(session) => void deleteSession(session)} onOpenSettings={() => setSettingsOpen(true)} onOpenSkills={() => setSkillsOpen(true)} skillsOpen={skillsOpen} onCollapse={() => setLeftCollapsed(true)} /> : null}
      {skillsOpen ? <SkillMarketplace workspace={active.workspace} onClose={() => setSkillsOpen(false)} /> : <section className="main-shell">
        <Topbar session={active} onUpdate={(patch) => void updateSession(patch)} onPickWorkspace={() => void pickWorkspace()} onDelete={() => void deleteSession(active)} leftCollapsed={leftCollapsed} rightOpen={rightOpen} onToggleLeft={() => setLeftCollapsed((v) => !v)} onToggleRight={() => setRightOpen((v) => !v)} />
        <Transcript
          items={activeItems}
          displayName={activeDisplayName}
          onOpenPath={(path) => void openPath(path)}
          onError={setError}
          planMode={active.mode === 'plan'}
          onAcceptPlan={(planText) => void acceptPlan(planText)}
          onRevisePlan={(planText) => void revisePlan(planText)}
          onCancelPlan={() => void cancelPlan()}
        />
        {clarification ? (
          <ClarificationCard clarification={clarification} onRespond={respondClarification} />
        ) : (
          <Composer
            busy={active.busy}
            session={active}
            profiles={settings.profiles}
            workspaces={workspaces}
            contextUsed={active.contextTokens ?? active.lastInputTokens}
            contextWindow={active.contextWindow}
            onSend={send}
            onStop={() => void stop()}
            onUpdate={(patch) => void updateSession(patch)}
            onPickWorkspace={() => pickWorkspace()}
            onChooseImages={() => window.ranparty.chooseImages()}
            onCompact={compactContext}
            onOpenSkills={() => setSkillsOpen(true)}
            draftText={composerDraft}
            onDraftConsumed={() => setComposerDraft('')}
          />
        )}
      </section>}
      {rightOpen && !skillsOpen ? <RightPanel session={active} messages={activeItems} onClose={() => setRightOpen(false)} onOpenPath={(path) => void openPath(path)} onSendSide={(text) => send(text, [], [], [])} onError={setError} /> : null}
      {newTask !== null ? <NewTaskModal initialWorkspace={newTask} workspaces={workspaces} profiles={settings.profiles} onClose={() => setNewTask(null)} onBrowse={async () => await window.ranparty.chooseDirectory() ?? ''} onCreate={createTask} /> : null}
      {settingsOpen ? <SettingsDrawer settings={settings} onClose={() => setSettingsOpen(false)} onSave={saveSettings} /> : null}
      {approval ? <ApprovalModal approval={approval} onRespond={respondApproval} /> : null}
      {error ? <div className="error-toast" role="alert"><span>{error}</span><button onClick={() => setError('')}>×</button></div> : null}
    </div>
  )
}

function messageOf(reason: unknown) {
  return reason instanceof Error ? reason.message : String(reason)
}

function genId(prefix: string) {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`
}

function makeAssistantItem(messageId: string, content: string, streaming: boolean): AssistantMessageItem {
  return { type: 'assistant_message', id: messageId, status: 'in_progress', content, streaming }
}

function makeErrorItem(message: string): ErrorItem {
  return { type: 'error', id: genId('error'), status: 'failed', message }
}

function normalizeBackendEvent(event: string, raw: unknown): ThreadEvent | null {
  const data = raw as Record<string, unknown> | undefined
  if (!data && event !== 'settings.changed') return null

  switch (event) {
    case 'session.created':
      return { type: 'session.created', session: raw as Session }
    case 'session.deleted':
      return { type: 'session.deleted', sessionId: String(data?.sessionId ?? '') }
    case 'session.updated':
      return { type: 'session.updated', session: raw as Session }
    case 'settings.changed':
      return { type: 'settings.changed', settings: (raw || data) as Settings }
    case 'skills.changed':
      return { type: 'skills.changed' }
    case 'message.added':
      return { type: 'message.added', sessionId: String(data?.sessionId ?? ''), message: data?.message as RawMessage || (raw as RawMessage) }
    case 'assistant.started':
      return { type: 'assistant.started', sessionId: String(data?.sessionId ?? ''), messageId: String(data?.messageId ?? '') }
    case 'assistant.delta':
      return { type: 'assistant.delta', sessionId: String(data?.sessionId ?? ''), messageId: String(data?.messageId ?? ''), delta: String(data?.delta ?? '') }
    case 'assistant.reasoning':
      return { type: 'assistant.reasoning', sessionId: String(data?.sessionId ?? ''), messageId: String(data?.messageId ?? ''), delta: String(data?.delta ?? '') }
    case 'assistant.completed':
      return { type: 'assistant.completed', sessionId: String(data?.sessionId ?? ''), messageId: String(data?.messageId ?? ''), content: data?.content, usageIn: data?.usageIn, usageOut: data?.usageOut, model: data?.model }
    case 'chat.cancelled':
      return { type: 'chat.cancelled', sessionId: String(data?.sessionId ?? '') }
    case 'chat.error':
      return { type: 'chat.error', sessionId: String(data?.sessionId ?? ''), message: String(data?.message ?? '') }
    case 'tool.started':
      return { type: 'tool.started', sessionId: String(data?.sessionId ?? ''), name: String(data?.name ?? ''), arguments: String(data?.arguments ?? ''), agentName: String(data?.agentName ?? '') }
    case 'tool.completed':
      return { type: 'tool.completed', sessionId: String(data?.sessionId ?? ''), name: String(data?.name ?? ''), content: String(data?.content ?? ''), path: String(data?.path ?? ''), isError: Boolean(data?.isError), agentName: String(data?.agentName ?? '') }
    case 'approval.requested':
      return { type: 'approval.requested', approval: raw as ApprovalRequest }
    case 'clarification.requested':
      return { type: 'clarification.requested', clarification: raw as ClarificationRequest }
    case 'context.compacted':
      return { type: 'context.compacted', sessionId: String(data?.sessionId ?? ''), automatic: Boolean(data?.automatic), profileName: String(data?.profileName ?? ''), contextTokens: Number(data?.contextTokens ?? 0), beforeTokens: Number(data?.beforeTokens ?? 0) }
    case 'internal.notice':
      return { type: 'internal.notice', sessionId: String(data?.sessionId ?? ''), content: String(data?.content ?? '') }
    case 'backend.error':
      return { type: 'backend.error', message: String(data?.message ?? '') }
    case 'backend.exited':
      return { type: 'backend.exited', code: data?.code as number | undefined }
    default:
      console.warn('Unknown backend event:', event, data)
      return null
  }
}
