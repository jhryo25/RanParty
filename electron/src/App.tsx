import { useEffect, useMemo, useState } from 'react'
import { ApprovalModal } from './components/ApprovalModal'
import { Composer } from './components/Composer'
import { SettingsDrawer } from './components/SettingsDrawer'
import { Sidebar } from './components/Sidebar'
import { Topbar } from './components/Topbar'
import { Transcript } from './components/Transcript'
import { NewTaskModal } from './components/NewTaskModal'
import { RightPanel } from './components/RightPanel'
import { SkillMarketplace } from './components/SkillMarketplace'
import type { ApprovalRequest, Bootstrap, RawMessage, Session, Settings, UiMessage } from './types'
import { toUiMessages } from './types'

type MessageMap = Record<string, UiMessage[]>

export default function App() {
  const [sessions, setSessions] = useState<Session[]>([])
  const [settings, setSettings] = useState<Settings | null>(null)
  const [messages, setMessages] = useState<MessageMap>({})
  const [activeId, setActiveId] = useState('')
  const [approval, setApproval] = useState<ApprovalRequest | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const [leftCollapsed, setLeftCollapsed] = useState(false)
  const [rightOpen, setRightOpen] = useState(true)
  const [newTask, setNewTask] = useState<string | null>(null)
  const [skillsOpen, setSkillsOpen] = useState(false)

  useEffect(() => {
    window.ranparty.onEvent((event, data) => handleBackendEvent(event, data))
    window.ranparty.request<Bootstrap>('app.bootstrap')
      .then((result) => {
        setSessions(result.sessions)
        setSettings(result.settings)
        setMessages(Object.fromEntries(result.sessions.map((session) => [session.id, toUiMessages(session.messages)])))
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

  useEffect(() => { const toggle = (event: KeyboardEvent) => { if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'b') { event.preventDefault(); setLeftCollapsed(value => !value) } }; window.addEventListener('keydown', toggle); return () => window.removeEventListener('keydown', toggle) }, [])
  useEffect(() => { if (window.ranparty.isElectron) document.body.classList.add('electron-shell'); return () => document.body.classList.remove('electron-shell') }, [])

  const active = useMemo(() => sessions.find((session) => session.id === activeId) ?? sessions[0], [sessions, activeId])
  const activeDisplayName = useMemo(() => settings?.profiles.find((profile) => profile.name === active?.profileName)?.characterDisplayName || active?.displayName || 'AI', [settings, active])
  const workspaces = useMemo(() => [...new Set(sessions.map((session) => session.workspace).filter(Boolean))], [sessions])

  const handleBackendEvent = (event: string, raw: unknown) => {
    const data = raw as Record<string, unknown>
    const sessionId = String(data?.sessionId ?? '')
    if (event === 'session.created') {
      const session = raw as Session
      setSessions((current) => [session, ...current.filter((item) => item.id !== session.id)])
      setMessages((current) => ({ ...current, [session.id]: toUiMessages(session.messages) }))
      setActiveId(session.id)
      return
    }
    if (event === 'session.deleted') {
      setSessions((current) => current.filter((session) => session.id !== sessionId))
      setMessages((current) => { const next = { ...current }; delete next[sessionId]; return next })
      setActiveId((current) => current === sessionId ? '' : current)
      return
    }
    if (event === 'session.updated') {
      const update = raw as Session
      setSessions((current) => current.map((session) => session.id === update.id ? { ...update, messages: session.messages } : session))
      return
    }
    if (event === 'settings.changed') {
      setSettings(raw as Settings)
      return
    }
    if (event === 'approval.requested') {
      setApproval(raw as ApprovalRequest)
      return
    }
    if (event === 'message.added') {
      const message = data.message as RawMessage
      appendMessage(sessionId, { ...toUiMessages([message])[0], id: `user_${Date.now()}` })
      return
    }
    if (event === 'assistant.started') {
      appendMessage(sessionId, { id: String(data.messageId), role: 'assistant', content: '', reasoning: '', streaming: true })
      return
    }
    if (event === 'assistant.delta' || event === 'assistant.reasoning') {
      updateMessage(sessionId, String(data.messageId), (message) => event === 'assistant.delta'
        ? { ...message, content: message.content + String(data.delta ?? '') }
        : { ...message, reasoning: (message.reasoning ?? '') + String(data.delta ?? '') })
      return
    }
    if (event === 'assistant.completed') {
      updateMessage(sessionId, String(data.messageId), (message) => ({
        ...message,
        content: String(data.content ?? message.content),
        streaming: false,
        usageIn: Number(data.usageIn ?? 0),
        usageOut: Number(data.usageOut ?? 0),
        model: String(data.model ?? ''),
      }))
      return
    }
    if (event === 'chat.cancelled') {
      setMessages((current) => ({
        ...current,
        [sessionId]: (current[sessionId] ?? []).map((message) => message.role === 'assistant' && message.streaming
          ? { ...message, content: message.content || '已停止生成', streaming: false }
          : message),
      }))
      return
    }
    if (event === 'tool.started') {
      setMessages((current) => {
        const list = [...(current[sessionId] ?? [])]
        const assistantIndex = list.findLastIndex((message) => message.role === 'assistant')
        if (assistantIndex >= 0) list[assistantIndex] = { ...list[assistantIndex], hasToolCalls: true }
        return { ...current, [sessionId]: list }
      })
      appendMessage(sessionId, {
        id: `tool_${Date.now()}_${Math.random()}`,
        role: 'tool',
        content: '',
        toolName: String(data.name ?? '工具'),
        toolArguments: String(data.arguments ?? ''),
        agentName: String(data.agentName ?? ''),
        streaming: true,
      })
      return
    }
    if (event === 'tool.completed') {
      updateLastTool(sessionId, String(data.name ?? ''), (message) => ({
        ...message,
        content: String(data.content ?? ''),
        toolPath: String(data.path ?? ''),
        toolError: Boolean(data.isError),
        agentName: String(data.agentName ?? message.agentName ?? ''),
        streaming: false,
      }))
      return
    }
    if (event === 'chat.error') {
      const text = String(data?.message ?? '模型请求失败')
      setError(text)
      setMessages((current) => {
        const list = [...(current[sessionId] ?? [])]
        const index = list.findLastIndex((message) => message.role === 'assistant' && message.streaming)
        if (index >= 0) list[index] = { ...list[index], content: text, streaming: false, error: true }
        else list.push({ id: `error_${Date.now()}`, role: 'assistant', content: text, error: true })
        return { ...current, [sessionId]: list }
      })
      return
    }
    if (event === 'backend.error' || event === 'backend.exited') {
      setError(String(data?.message ?? `后端异常：${event}`))
      return
    }
  }

  const appendMessage = (sessionId: string, message: UiMessage) => {
    setMessages((current) => ({ ...current, [sessionId]: [...(current[sessionId] ?? []), message] }))
  }
  const updateMessage = (sessionId: string, messageId: string, updater: (message: UiMessage) => UiMessage) => {
    setMessages((current) => ({ ...current, [sessionId]: (current[sessionId] ?? []).map((message) => message.id === messageId ? updater(message) : message) }))
  }
  const updateLastTool = (sessionId: string, name: string, updater: (message: UiMessage) => UiMessage) => {
    setMessages((current) => {
      const list = [...(current[sessionId] ?? [])]
      const index = list.findLastIndex((message) => message.role === 'tool' && message.toolName === name && message.streaming)
      if (index >= 0) list[index] = updater(list[index])
      return { ...current, [sessionId]: list }
    })
  }

  const createSession = async (workspace?: string) => {
    setSkillsOpen(false)
    setNewTask(workspace ?? '')
  }
  const createTask = async ({ prompt, workspace, profileName, skillIds }: { prompt: string; workspace: string; profileName: string; skillIds: string[] }) => { try { const session = await window.ranparty.request<Session>('session.create', { workspace }); await window.ranparty.request('session.update', { sessionId: session.id, profileName }); await window.ranparty.request('chat.send', { sessionId: session.id, text: prompt, imageDataUrls: [], skillIds }) } catch (reason) { setError(messageOf(reason)); throw reason } }
  const updateSession = async (patch: Record<string, unknown>, sessionId = active?.id) => {
    if (!sessionId) return
    try { await window.ranparty.request('session.update', { sessionId, ...patch }) }
    catch (reason) { setError(messageOf(reason)) }
  }
  const pickWorkspace = async (sessionId = active?.id) => {
    const workspace = await window.ranparty.chooseDirectory()
    if (workspace) await updateSession({ workspace }, sessionId)
  }
  const send = async (text: string, imageDataUrls: string[], skillIds: string[]) => {
    if (!active) return
    try { await window.ranparty.request('chat.send', { sessionId: active.id, text, imageDataUrls, skillIds }) }
    catch (reason) { setError(messageOf(reason)); throw reason }
  }
  const deleteSession = async (session: Session) => {
    if (!window.confirm(`确定删除会话“${session.title}”吗？此操作不可撤销。`)) return
    try { await window.ranparty.request('session.delete', { sessionId: session.id }) }
    catch (reason) { setError(messageOf(reason)) }
  }
  const renameSession = async (session: Session) => {
    const title = window.prompt('重命名会话', session.title)?.trim()
    if (title && title !== session.title) await updateSession({ title }, session.id)
  }
  const stop = async () => {
    if (active) await window.ranparty.request('chat.cancel', { sessionId: active.id })
  }
  const compactContext = async (profileName?: string) => {
    if (!active) return
    try { await window.ranparty.request('session.compact', { sessionId: active.id, profileName: profileName || active.profileName }) }
    catch (reason) { setError(messageOf(reason)); throw reason }
  }
  const respondApproval = async (action: 'reject' | 'allow_once' | 'allow_session', feedback = '') => {
    if (!approval) return
    await window.ranparty.request('approval.respond', { approvalId: approval.approvalId, action, feedback })
    setApproval(null)
  }
  const saveSettings = async (payload: Record<string, unknown>) => {
    await window.ranparty.request('settings.save', payload)
  }
  const openPath = async (path: string) => {
    try { await window.ranparty.request('path.open', { path }) }
    catch (reason) { setError(messageOf(reason)) }
  }

  if (loading) return <div className="boot-screen"><span className="empty-mark">RP</span><p>正在启动 RanParty…</p></div>
  if (!active || !settings) return <div className="boot-screen"><p>{error || '没有可用会话'}</p><button className="primary-button" onClick={() => void createSession()}>新建会话</button></div>

  return (
    <div className={`app-shell ${leftCollapsed ? 'left-collapsed' : ''} ${rightOpen && !skillsOpen ? 'right-open' : ''}`}>
      {!leftCollapsed ? <Sidebar sessions={sessions} activeId={active.id} onSelect={(id) => { setActiveId(id); setSkillsOpen(false) }} onCreate={(workspace) => void createSession(workspace)} onRename={(session) => void renameSession(session)} onDelete={(session) => void deleteSession(session)} onOpenSettings={() => setSettingsOpen(true)} onOpenSkills={() => setSkillsOpen(true)} skillsOpen={skillsOpen} onCollapse={() => setLeftCollapsed(true)} /> : null}
      {skillsOpen ? <SkillMarketplace workspace={active.workspace} onClose={() => setSkillsOpen(false)} /> : <section className="main-shell">
        <Topbar session={active} onUpdate={(patch) => void updateSession(patch)} onPickWorkspace={() => void pickWorkspace()} onDelete={() => void deleteSession(active)} leftCollapsed={leftCollapsed} rightOpen={rightOpen} onToggleLeft={() => setLeftCollapsed(value => !value)} onToggleRight={() => setRightOpen(value => !value)} />
        <Transcript messages={messages[active.id] ?? []} displayName={activeDisplayName} onOpenPath={(path) => void openPath(path)} onError={setError} />
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
        />
      </section>}
      {rightOpen && !skillsOpen ? <RightPanel session={active} messages={messages[active.id] ?? []} onClose={() => setRightOpen(false)} onOpenPath={(path) => void openPath(path)} onSendSide={(text) => send(text, [], [])} onError={setError} /> : null}
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
