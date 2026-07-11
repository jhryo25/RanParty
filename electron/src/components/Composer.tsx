import { LoaderCircle, Mic, Plus, Send, Square, X } from 'lucide-react'
import { ChangeEvent, DragEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Attachment, Profile, SendEnvelope, Session, SessionMode } from '../types'
import { useComposerActions } from '../hooks/useComposerActions'
import { useComposerDraft } from '../hooks/useComposerDraft'
import { useComposerQueue } from '../hooks/useComposerQueue'
import { useComposerResources } from '../hooks/useComposerResources'
import { ApprovalControl, ContextControl, ModeControl, ModelControl, WorkspaceControl } from './ComposerControls'
import { ComposerQueue, ComposerSelections } from './ComposerFeedback'
import { ComposerQuickMenu, QuickPanel } from './ComposerPanels'
import { filterSkills, isExpertSkill, messageOf, toggleId } from './composer-utils'

interface Props {
  busy: boolean
  session: Session
  sessions: Session[]
  profiles: Profile[]
  workspaces: string[]
  contextUsed: number
  contextWindow: number
  onSend: (envelope: SendEnvelope) => Promise<void>
  onStop: () => void
  onUpdate: (patch: Record<string, unknown>) => Promise<void>
  onPickWorkspace: () => Promise<void>
  onChooseImages: () => Promise<Attachment[]>
  onCompact: (profileName?: string) => Promise<void>
  onOpenSkills?: () => void
  onAddSessionReference: (referenceId: string) => Promise<void>
  onRemoveSessionReference: (referenceId: string) => Promise<void>
  draftText?: string
  onDraftConsumed?: () => void
}

export function Composer(props: Props) {
  return <ComposerSession key={props.session.id} {...props} />
}

function ComposerSession(props: Props) {
  const {
    busy, session, sessions, profiles, workspaces, contextUsed, contextWindow, onSend, onStop,
    onUpdate, onPickWorkspace, onChooseImages, onCompact, onOpenSkills, onAddSessionReference,
    onRemoveSessionReference, draftText, onDraftConsumed,
  } = props
  const [notice, setNotice] = useState('')
  const [quickMenuOpen, setQuickMenuOpen] = useState(false)
  const [quickPanel, setQuickPanel] = useState<QuickPanel | null>(null)
  const [workspaceOpen, setWorkspaceOpen] = useState(false)
  const [contextOpen, setContextOpen] = useState(false)
  const [compactProfile, setCompactProfile] = useState(session.profileName)
  const [compacting, setCompacting] = useState(false)
  const [skillQuery, setSkillQuery] = useState('')
  const [referenceQuery, setReferenceQuery] = useState('')
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const draft = useComposerDraft(session.id)
  const { skills, connectors, loadSkills, loadConnectors } = useComposerResources({
    workspace: session.workspace,
    setSelectedSkillIds: draft.setSelectedSkillIds,
    setSelectedExpertIds: draft.setSelectedExpertIds,
    onNotice: setNotice,
  })
  const queueState = useComposerQueue({ sessions, onSend, onNotice: setNotice })

  const closeQuickMenus = useCallback(() => {
    setQuickMenuOpen(false)
    setQuickPanel(null)
  }, [])
  const selectedReferences = session.references ?? []
  const selectedReferenceIds = useMemo(() => selectedReferences.map((item) => item.id), [selectedReferences])
  const activeProfile = useMemo(() => profiles.find((profile) => profile.name === session.profileName), [profiles, session.profileName])
  const hasVisionHelper = useMemo(() => profiles.some((profile) => profile.supportsImages && profile.name !== session.profileName), [profiles, session.profileName])
  const canAttachImages = Boolean(activeProfile?.supportsImages || hasVisionHelper)
  const actions = useComposerActions({
    busy,
    session,
    activeProfile,
    canAttachImages,
    text: draft.text,
    setText: draft.setText,
    attachments: draft.attachments,
    setAttachments: draft.setAttachments,
    selectedSkillIds: draft.selectedSkillIds,
    selectedExpertIds: draft.selectedExpertIds,
    selectedReferenceIds,
    inputRef,
    clearCurrentDraft: draft.clearCurrentDraft,
    enqueue: queueState.enqueue,
    onSend,
    onUpdate,
    onChooseImages,
    onAddSessionReference,
    onNotice: setNotice,
    onCloseMenus: closeQuickMenus,
  })

  useEffect(() => {
    if (draftText) {
      draft.setText(draftText)
      inputRef.current?.focus()
      onDraftConsumed?.()
    }
    return () => {}
  }, [draft.setText, draftText, onDraftConsumed])

  useEffect(() => {
    const closePopovers = (event: PointerEvent) => {
      const target = event.target
      if (!(target instanceof Element) || !target.closest('.popover-anchor')) {
        closeQuickMenus()
        setWorkspaceOpen(false)
        setContextOpen(false)
      }
    }
    document.addEventListener('pointerdown', closePopovers)
    return () => document.removeEventListener('pointerdown', closePopovers)
  }, [closeQuickMenus])

  useEffect(() => {
    setCompactProfile(session.profileName)
    return () => {}
  }, [session.profileName])

  const selectedSkills = useMemo(() => skills.filter((skill) => draft.selectedSkillIds.includes(skill.id)), [draft.selectedSkillIds, skills])
  const expertSkills = useMemo(() => skills.filter(isExpertSkill), [skills])
  const selectedExperts = useMemo(() => expertSkills.filter((skill) => draft.selectedExpertIds.includes(skill.id)), [draft.selectedExpertIds, expertSkills])
  const filteredSkills = useMemo(() => filterSkills(skills.filter((skill) => !isExpertSkill(skill)), skillQuery), [skillQuery, skills])
  const filteredExperts = useMemo(() => filterSkills(expertSkills, skillQuery), [expertSkills, skillQuery])
  const referenceOptions = useMemo(() => {
    const selectedIds = new Set(selectedReferenceIds)
    const query = referenceQuery.trim().toLocaleLowerCase()
    return sessions
      .filter((item) => item.id !== session.id && !selectedIds.has(item.id))
      .filter((item) => !query || `${item.title} ${item.workspace} ${item.id}`.toLocaleLowerCase().includes(query))
      .toSorted((left, right) => (new Date(right.lastActive).getTime() || 0) - (new Date(left.lastActive).getTime() || 0))
      .slice(0, 30)
  }, [referenceQuery, selectedReferenceIds, session.id, sessions])
  const workspaceOptions = useMemo(() => {
    const values = [...workspaces]
    if (session.workspace && !values.includes(session.workspace)) values.unshift(session.workspace)
    return values
  }, [session.workspace, workspaces])
  const percentage = Number.isNaN(contextUsed) || Number.isNaN(contextWindow)
    ? 0
    : Math.min(100, Math.round((contextUsed / Math.max(1, contextWindow)) * 100))

  const compact = useCallback(async () => {
    if (compacting || busy) return
    setCompacting(true)
    try {
      await onCompact(compactProfile)
      setContextOpen(false)
    } catch (error) {
      setNotice(`上下文总结失败：${messageOf(error)}`)
    } finally {
      setCompacting(false)
    }
  }, [busy, compactProfile, compacting, onCompact])

  const changeMode = useCallback((mode: SessionMode) => {
    if (mode === 'goal') {
      const goal = window.prompt('Goal 模式目标是什么？', session.goal?.text ?? '')?.trim()
      if (!goal) return
      void onUpdate({ mode, goal: { text: goal, status: 'active' } }).catch(() => {})
      return
    }
    void onUpdate({ mode }).catch(() => {})
  }, [onUpdate, session.goal?.text])

  const openPanel = useCallback((panel: QuickPanel) => {
    setQuickPanel(panel)
    if (panel === 'skills' || panel === 'experts') void loadSkills()
    if (panel === 'connectors') void loadConnectors()
  }, [loadConnectors, loadSkills])
  const pickWorkspace = useCallback(async () => {
    setWorkspaceOpen(false)
    await onPickWorkspace()
  }, [onPickWorkspace])
  const toggleQuickMenu = useCallback(() => {
    const opening = !quickMenuOpen
    setQuickMenuOpen(opening)
    setQuickPanel(null)
    setWorkspaceOpen(false)
    setContextOpen(false)
  }, [quickMenuOpen])
  const removeAttachment = useCallback((index: number) => draft.setAttachments((current) => current.filter((_, itemIndex) => itemIndex !== index)), [draft.setAttachments])
  const removeExpert = useCallback((id: string) => draft.setSelectedExpertIds((current) => current.filter((item) => item !== id)), [draft.setSelectedExpertIds])
  const removeSkill = useCallback((id: string) => draft.setSelectedSkillIds((current) => current.filter((item) => item !== id)), [draft.setSelectedSkillIds])
  const removeReference = useCallback((id: string) => { void onRemoveSessionReference(id) }, [onRemoveSessionReference])
  const addReference = useCallback((id: string) => { void onAddSessionReference(id) }, [onAddSessionReference])
  const toggleExpert = useCallback((id: string) => toggleId(draft.setSelectedExpertIds, id), [draft.setSelectedExpertIds])
  const toggleSkill = useCallback((id: string) => toggleId(draft.setSelectedSkillIds, id), [draft.setSelectedSkillIds])
  const changeText = useCallback((event: ChangeEvent<HTMLTextAreaElement>) => draft.setText(event.target.value), [draft.setText])
  const allowDrop = useCallback((event: DragEvent<HTMLDivElement>) => event.preventDefault(), [])
  const dismissNotice = useCallback(() => setNotice(''), [])
  const canSend = Boolean(session.workspace) && !busy && !actions.sending && (Boolean(draft.text.trim()) || draft.attachments.length > 0)

  return <div className="composer-wrap compact-composer-wrap">
    <div className={`composer compact-composer ${busy ? 'busy' : ''} ${!session.workspace ? 'needs-workspace' : ''}`} onDrop={actions.onDrop} onDragOver={allowDrop}>
      <ComposerSelections attachments={draft.attachments} references={selectedReferences} experts={selectedExperts} skills={selectedSkills} onRemoveAttachment={removeAttachment} onRemoveReference={removeReference} onRemoveExpert={removeExpert} onRemoveSkill={removeSkill} />
      <ComposerQueue queue={queueState.queue} sessions={sessions} onRetry={queueState.retry} onRemove={queueState.remove} />
      <textarea ref={inputRef} value={draft.text} onChange={changeText} onKeyDown={actions.onKeyDown} onPaste={actions.onPaste} disabled={actions.sending} aria-label="任务消息" placeholder={!session.workspace ? '请先选择工作区' : busy ? '任务运行中：输入后按 Enter 加入队列' : '要求进行后续变更'} rows={1} />
      {busy ? <div className="composer-queue-hint" role="status">当前任务运行中；仍可继续输入，按 Enter 后会排队并在本轮结束后自动发送。</div> : null}
      {notice ? <div className="composer-notice inline-notice">{notice}<button onClick={dismissNotice}><X size={13} /></button></div> : null}
      <div className="composer-actions">
        <div className="composer-left">
          <div className="popover-anchor">
            <button className={`round-icon-button composer-plus ${quickMenuOpen ? 'active' : ''}`} onClick={toggleQuickMenu} aria-label="打开输入菜单"><Plus size={19} /></button>
            {quickMenuOpen ? <ComposerQuickMenu activeProfile={activeProfile} hasVisionHelper={hasVisionHelper} canAttachImages={canAttachImages} quickPanel={quickPanel} selectedExpertsCount={selectedExperts.length} selectedSkillsCount={selectedSkills.length} referenceItems={referenceOptions} selectedReferenceIds={selectedReferenceIds} referenceQuery={referenceQuery} onReferenceQuery={setReferenceQuery} expertItems={filteredExperts} selectedExpertIds={draft.selectedExpertIds} skillItems={filteredSkills} selectedSkillIds={draft.selectedSkillIds} skillQuery={skillQuery} onSkillQuery={setSkillQuery} connectors={connectors} onChooseImages={actions.chooseImages} onOpenPanel={openPanel} onAddReference={addReference} onToggleExpert={toggleExpert} onToggleSkill={toggleSkill} onOpenSkills={onOpenSkills} /> : null}
          </div>
          <ApprovalControl approvalMode={session.approvalMode} disabled={busy || actions.sending} onUpdate={onUpdate} />
          <ModeControl currentMode={session.mode ?? 'default'} goalText={session.goal?.text} disabled={busy || actions.sending} onChange={changeMode} />
          <WorkspaceControl workspace={session.workspace} workspaces={workspaceOptions} disabled={busy || actions.sending} onUpdate={onUpdate} open={workspaceOpen} setOpen={setWorkspaceOpen} onBrowse={pickWorkspace} />
        </div>
        <div className="composer-right">
          <ModelControl session={session} profiles={profiles} disabled={busy || actions.sending} onUpdate={onUpdate} />
          <ContextControl open={contextOpen} setOpen={setContextOpen} percentage={percentage} contextUsed={contextUsed} contextWindow={contextWindow} profiles={profiles} compactProfile={compactProfile} setCompactProfile={setCompactProfile} compacting={compacting} busy={busy} onCompact={compact} />
          <button className="round-icon-button muted" title="语音输入暂未启用"><Mic size={16} /></button>
          {busy
            ? <button className="round-send-button stop" aria-label={session.turnState === 'cancelling' ? '正在停止当前任务' : '停止当前任务'} disabled={session.turnState === 'cancelling'} onClick={onStop} title={session.turnState === 'cancelling' ? '正在停止…' : '停止生成'}>{session.turnState === 'cancelling' ? <LoaderCircle className="spin" size={15} /> : <Square size={15} />}</button>
            : <button className="round-send-button" aria-label="发送消息" onClick={actions.send} disabled={!canSend} title="发送"><Send size={17} /></button>}
          {queueState.queue.length > 0 ? <span className="phase-indicator">{queueState.queue.length} 条排队</span> : null}
        </div>
      </div>
    </div>
    <p className="ai-disclaimer">内容由 AI 生成，请核实重要信息</p>
  </div>
}
