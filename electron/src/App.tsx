import { lazy, Suspense, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { ApprovalModal } from './components/ApprovalModal'
import { ClarificationCard } from './components/ClarificationCard'
import { Composer } from './components/Composer'
import { NewTaskPage } from './components/NewTaskModal'
import { RightPanel } from './components/RightPanel'
import { Sidebar } from './components/Sidebar'
import { Topbar } from './components/Topbar'
import { Transcript } from './components/Transcript'
import type { ExpertConversationStart, SendEnvelope, Session } from './types'
import { useBackendRuntime } from './hooks/use-backend-runtime'
import { genId } from './state/session-runtime'
import { approvalId, clarificationId, dequeuePending } from './state/thread-state'
import { readDraft, writeDraft } from './components/composer-store'

const SettingsDrawer = lazy(() => import('./components/SettingsDrawer').then((module) => ({ default: module.SettingsDrawer })))
const SkillMarketplace = lazy(() => import('./components/SkillMarketplace').then((module) => ({ default: module.SkillMarketplace })))

export default function App() {
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [toast, setToast] = useState('')
  const [leftCollapsed, setLeftCollapsed] = useState(false)
  const [rightOpen, setRightOpen] = useState(false)
  const [leftWidth, setLeftWidth] = useState(() => Number(localStorage.getItem('ranparty.left-width')) || 248)
  const [rightWidth, setRightWidth] = useState(() => Number(localStorage.getItem('ranparty.right-width')) || 430)
  const [newTask, setNewTask] = useState<string | null>(null)
  const [skillsOpen, setSkillsOpen] = useState(false)
  const [composerDraft, setComposerDraft] = useState('')
  const [planSinceIndex, setPlanSinceIndex] = useState<Record<string, number>>({})
  const planAcceptingRef = useRef(false)
  const { sessions, setSessions, settings, items, activeId, setActiveId, approvals, setApprovals, clarifications, setClarifications, loading, error, setError, appendItem, adoptSession } = useBackendRuntime({ setRightOpen })
  const startExpertConversation = ({ expertId, teamId, prompt }: ExpertConversationStart) => {
    const draft = readDraft(activeId)
    const expertIds = expertId ? (draft.expertIds.includes(expertId) ? draft.expertIds : [...draft.expertIds, expertId].slice(-3)) : []
    const text = prompt ? (draft.text.trim() ? `${draft.text.trim()}\n${prompt}` : prompt) : draft.text
    writeDraft(activeId, { ...draft, text, expertTeamId: teamId ?? (expertId ? '' : draft.expertTeamId), expertIds })
    setSkillsOpen(false); setToast('专家与话术已带回当前输入框')
  }

  useEffect(() => {
    if (!error || error.includes('后端')) return
    const timer = window.setTimeout(() => setError(''), 5000)
    return () => window.clearTimeout(timer)
  }, [error])

  const shellStyle = { '--left-width': `${leftWidth}px`, '--right-width': `${rightWidth}px` } as CSSProperties
  const beginResize = (side: 'left' | 'right', event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault()
    const startX = event.clientX
    const startWidth = side === 'left' ? leftWidth : rightWidth
    const move = (moveEvent: PointerEvent) => {
      const delta = moveEvent.clientX - startX
      const next = Math.max(side === 'left' ? 210 : 320, Math.min(side === 'left' ? 420 : 720, startWidth + (side === 'left' ? delta : -delta)))
      if (side === 'left') setLeftWidth(next); else setRightWidth(next)
    }
    const stopResize = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', stopResize)
      document.body.classList.remove('resizing-panels')
    }
    document.body.classList.add('resizing-panels')
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', stopResize)
  }
  useEffect(() => { localStorage.setItem('ranparty.left-width', String(leftWidth)) }, [leftWidth])
  useEffect(() => { localStorage.setItem('ranparty.right-width', String(rightWidth)) }, [rightWidth])

  useEffect(() => {
    if (!toast) return
    const timer = window.setTimeout(() => setToast(''), 2600)
    return () => window.clearTimeout(timer)
  }, [toast])

  useEffect(() => {
    const toggle = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'b') {
        event.preventDefault()
        setLeftCollapsed((value) => !value)
      }
      if ((event.ctrlKey || event.metaKey) && event.key === ',') {
        event.preventDefault()
        setSettingsOpen(true)
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
  const activeApproval = active ? approvals[active.id]?.[0] ?? null : null
  const activeClarification = active ? clarifications[active.id]?.[0] ?? null : null
  const pendingSessionIds = useMemo(() => new Set([...Object.keys(approvals), ...Object.keys(clarifications)]), [approvals, clarifications])

  useEffect(() => {
    if (!loading && settings && sessions.length === 0) setNewTask((current) => current ?? '')
  }, [loading, sessions.length, settings])

  const createSession = async (workspace?: string) => { setSkillsOpen(false); setNewTask(workspace ?? '') }

  const createTask = async ({ clientMessageId, prompt, workspace, profileName, approvalMode, mode, imageDataUrls }: { clientMessageId: string; prompt: string; workspace: string; profileName: string; approvalMode: 'ask' | 'auto'; mode: Session['mode']; imageDataUrls: string[] }) => {
    try {
      const result = await window.ranparty.request<{ session?: Session }>('session.create_and_send', { clientMessageId, workspace, profileName, approvalMode, mode, text: prompt, imageDataUrls, fileDataUrls: [], skillIds: [], expertIds: [], referencedSessionIds: [] })
      if (result.session) adoptSession(result.session)
    } catch (reason) {
      setError(messageOf(reason))
      throw reason
    }
  }

  const updateSession = async (patch: Record<string, unknown>, sessionId = active?.id) => {
    if (!sessionId) return
    const existing = sessions.find((session) => session.id === sessionId)
    setSessions((current) => current.map((session) => session.id === sessionId ? { ...session, ...patch } : session))
    if (patch.mode === 'plan') setPlanSinceIndex((current) => ({ ...current, [sessionId]: items[sessionId]?.length ?? 0 }))
    else if (patch.mode) setPlanSinceIndex((current) => ({ ...current, [sessionId]: -1 }))
    try { await window.ranparty.request('session.update', { sessionId, ...patch }) }
    catch (reason) {
      if (existing) setSessions((current) => current.map((session) => session.id === sessionId ? existing : session))
      setError(messageOf(reason))
      throw reason
    }
  }

  const pickWorkspace = async (sessionId = active?.id) => {
    try {
      const workspace = await window.ranparty.chooseDirectory()
      if (workspace) await updateSession({ workspace }, sessionId)
    } catch {
      // updateSession already surfaced the actionable error.
    }
  }

  const send = async (envelope: SendEnvelope) => {
    try {
      await window.ranparty.request('chat.send', { ...envelope })
    } catch (reason) {
      setError(messageOf(reason))
      throw reason
    }
  }

  const copySessionId = async (session: Session) => {
    try {
      await window.ranparty.clipboardWrite(session.id)
      setToast(`已复制 Session ID：${session.title}`)
    } catch (reason) { setError(messageOf(reason)) }
  }

  const copySessionReference = async (session: Session) => {
    try {
      await window.ranparty.clipboardWrite(formatSessionReference(session))
      setToast(`已复制会话引用：${session.title}`)
    } catch (reason) { setError(messageOf(reason)) }
  }

  const addSessionReference = async (referenceId: string) => {
    if (!active) return
    try {
      const result = await window.ranparty.request<{ reference?: { title?: string }; added?: boolean }>('session.reference.add', { sessionId: active.id, referenceId })
      setToast(result.added === false ? '该会话已经在当前上下文中' : `已引用会话：${result.reference?.title ?? referenceId}`)
    } catch (reason) { setError(messageOf(reason)) }
  }

  const removeSessionReference = async (referenceId: string) => {
    if (!active) return
    try {
      await window.ranparty.request('session.reference.remove', { sessionId: active.id, referenceId })
      setToast('已取消会话引用')
    } catch (reason) { setError(messageOf(reason)) }
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

  const stop = async () => {
    if (!active?.activeTurnId) return
    try { await window.ranparty.request('chat.cancel', { sessionId: active.id, turnId: active.activeTurnId }) }
    catch (reason) { setError(messageOf(reason)) }
  }

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

  const respondApproval = async (action: 'reject' | 'allow_once' | 'allow_session' | 'allow_always', feedback = '') => {
    if (!activeApproval) return
    try {
      await window.ranparty.request('approval.respond', { approvalId: activeApproval.approvalId, sessionId: activeApproval.sessionId, turnId: activeApproval.turnId, action, feedback })
      setApprovals((current) => dequeuePending(current, activeApproval.sessionId, activeApproval.approvalId, approvalId))
    } catch (reason) {
      setError(messageOf(reason))
      throw reason
    }
  }

  const respondClarification = async (text: string, selection: string[]) => {
    if (!activeClarification) return
    try {
      await window.ranparty.request('clarification.respond', { clarificationId: activeClarification.clarificationId, sessionId: activeClarification.sessionId, turnId: activeClarification.turnId, text, selection })
      setClarifications((current) => dequeuePending(current, activeClarification.sessionId, activeClarification.clarificationId, clarificationId))
    } catch (reason) {
      setError(messageOf(reason))
      throw reason
    }
  }

  const acceptPlan = async (_planText: string) => {
    if (!active || planAcceptingRef.current) return
    planAcceptingRef.current = true
    try {
      if (!active.planId || !active.planRevision) throw new Error('计划版本尚未同步，请稍后重试。')
      await window.ranparty.request('plan.accept', { sessionId: active.id, planId: active.planId, revision: active.planRevision, clientMessageId: genId('plan'), skillIds: [], expertIds: [], referencedSessionIds: [] })
    }
    catch (reason) { setError(messageOf(reason)) }
    finally { planAcceptingRef.current = false }
  }

  const revisePlan = async (planText: string) => {
    try {
      await updateSession({ mode: 'plan' })
      setComposerDraft(`请根据下面的计划继续修改，不要执行工具：\n\n${planText}`)
    } catch {
      // updateSession already surfaced the actionable error.
    }
  }

  const cancelPlan = async () => {
    if (!active) return
    try {
      await updateSession({ mode: 'default' }, active.id)
      setPlanSinceIndex((current) => ({ ...current, [active.id]: -1 }))
      appendItem(active.id, { type: 'system_notice', id: genId('plan_cancelled'), status: 'completed', content: '已取消本次计划执行。' })
    } catch {
      // updateSession already surfaced the actionable error.
    }
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
  if (!settings) {
    return <div className="boot-screen"><span className="empty-mark">RP</span><p>{error || '无法读取应用设置。'}</p></div>
  }
  if (!active) {
    return <div className={`app-shell ${leftCollapsed ? 'left-collapsed' : ''}`} style={shellStyle}>
      {!leftCollapsed ? <Sidebar sessions={sessions} activeId="" pendingSessionIds={pendingSessionIds} onSelect={() => {}} onCreate={(workspace) => void createSession(workspace)} onRename={() => {}} onDelete={() => {}} onCopySessionId={() => {}} onCopySessionReference={() => {}} onReferenceSession={() => {}} onOpenSettings={() => setSettingsOpen(true)} onOpenSkills={() => setSkillsOpen(true)} skillsOpen={skillsOpen} onCollapse={() => setLeftCollapsed(true)} /> : null}
      {newTask !== null ? <NewTaskPage initialWorkspace={newTask} workspaces={workspaces} profiles={settings.profiles} defaultApprovalMode={settings.shellMode} onClose={() => setNewTask(null)} onBrowse={async () => await window.ranparty.chooseDirectory() ?? ''} onCreate={createTask} /> : <div className="empty-app-shell"><span className="empty-mark">RP</span><h1>开始一个新任务</h1><p>当前没有会话。创建任务后即可继续。</p><button className="primary-button" onClick={() => setNewTask('')}>新建任务</button></div>}
      {settingsOpen ? <Suspense fallback={null}><SettingsDrawer settings={settings} onClose={() => setSettingsOpen(false)} onSave={saveSettings} /></Suspense> : null}
      {error ? <div className="error-toast" role="alert"><span>{error}</span><button aria-label="关闭错误" onClick={() => setError('')}>×</button></div> : null}
    </div>
  }

  return (
    <div className={`app-shell ${leftCollapsed ? 'left-collapsed' : ''} ${rightOpen && !skillsOpen ? 'right-open' : ''}`} style={shellStyle}>
      {!leftCollapsed ? <Sidebar sessions={sessions} activeId={active.id} pendingSessionIds={pendingSessionIds} onSelect={(id) => { setActiveId(id); setSkillsOpen(false); setNewTask(null) }} onCreate={(workspace) => void createSession(workspace)} onRename={(session) => void renameSession(session)} onDelete={(session) => void deleteSession(session)} onCopySessionId={(session) => void copySessionId(session)} onCopySessionReference={(session) => void copySessionReference(session)} onReferenceSession={(session) => void addSessionReference(session.id)} onOpenSettings={() => setSettingsOpen(true)} onOpenSkills={() => { setNewTask(null); setSkillsOpen(true) }} skillsOpen={skillsOpen} onCollapse={() => setLeftCollapsed(true)} /> : null}
      {!leftCollapsed ? <div className="panel-resizer left-resizer" role="separator" aria-label="调整左侧栏宽度" onPointerDown={(event) => beginResize('left', event)} /> : null}
      {newTask !== null ? <NewTaskPage initialWorkspace={newTask} workspaces={workspaces} profiles={settings.profiles} defaultApprovalMode={settings.shellMode} onClose={() => setNewTask(null)} onBrowse={async () => await window.ranparty.chooseDirectory() ?? ''} onCreate={createTask} /> : skillsOpen ? <Suspense fallback={<div className="loading-screen">正在加载 Skill 广场…</div>}><SkillMarketplace workspace={active.workspace} onStartConversation={startExpertConversation} onClose={() => setSkillsOpen(false)} /></Suspense> : <section className="main-shell">
        <Topbar session={active} onUpdate={(patch) => { void updateSession(patch).catch(() => {}) }} onPickWorkspace={() => void pickWorkspace()} onDelete={() => void deleteSession(active)} leftCollapsed={leftCollapsed} rightOpen={rightOpen} onToggleLeft={() => setLeftCollapsed((v) => !v)} onToggleRight={() => setRightOpen((v) => !v)} />
        <Transcript
          items={activeItems}
          displayName={activeDisplayName}
          onOpenPath={(path) => void openPath(path)}
          onError={setError}
          planMode={active.mode === 'plan' || active.mode === 'goal'}
          busy={active.busy}
          planSinceIndex={planSinceIndex[active.id] ?? -1}
          onAcceptPlan={acceptPlan}
          onRevisePlan={(planText) => void revisePlan(planText)}
          onCancelPlan={() => void cancelPlan()}
        />
        {activeClarification ? (
          <ClarificationCard key={activeClarification.clarificationId} clarification={activeClarification} onRespond={respondClarification} onCancel={() => void stop()} />
        ) : (
          <Composer
            busy={active.busy}
            session={active}
            sessions={sessions}
            profiles={settings.profiles}
            workspaces={workspaces}
            contextUsed={active.contextTokens ?? active.lastInputTokens}
            contextWindow={active.contextWindow}
            onSend={send}
            onStop={() => void stop()}
            onUpdate={updateSession}
            onPickWorkspace={() => pickWorkspace()}
            onChooseImages={() => window.ranparty.chooseImages()}
            onCompact={compactContext}
            onOpenSkills={() => setSkillsOpen(true)}
            onAddSessionReference={addSessionReference}
            onRemoveSessionReference={removeSessionReference}
            draftText={composerDraft}
            onDraftConsumed={() => setComposerDraft('')}
          />
        )}
      </section>}
       {rightOpen && !skillsOpen ? <><div className="panel-resizer right-resizer" role="separator" aria-label="调整右侧栏宽度" onPointerDown={(event) => beginResize('right', event)} /><RightPanel session={active} messages={activeItems} onClose={() => setRightOpen(false)} onOpenPath={(path) => void openPath(path)} onSendSide={(text) => send({ clientMessageId: genId('side'), sessionId: active.id, text, imageDataUrls: [], fileDataUrls: [], skillIds: [], expertIds: [], referencedSessionIds: [] })} onError={setError} /></> : null}
      {settingsOpen ? <Suspense fallback={null}><SettingsDrawer settings={settings} onClose={() => setSettingsOpen(false)} onSave={saveSettings} /></Suspense> : null}
      {activeApproval ? <ApprovalModal key={activeApproval.approvalId} approval={activeApproval} sessionTitle={active.title} onRespond={respondApproval} /> : null}
      {toast ? <div className="info-toast" role="status"><span>{toast}</span><button aria-label="关闭通知" onClick={() => setToast('')}>×</button></div> : null}
      {error ? <div className="error-toast" role="alert"><span>{error}</span><button aria-label="关闭错误" onClick={() => setError('')}>×</button></div> : null}
    </div>
  )
}

function messageOf(reason: unknown) {
  return reason instanceof Error ? reason.message : String(reason)
}

function formatSessionReference(session: Session) {
  return `@session:${session.id}`
}
