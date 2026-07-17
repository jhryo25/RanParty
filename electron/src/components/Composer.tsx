import { FilePlus2, FileText, LoaderCircle, Plus, Send, Square, X } from 'lucide-react'
import { ChangeEvent, DragEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Attachment, Profile, SendEnvelope, Session, SessionMode } from '../types'
import { useComposerActions } from '../hooks/useComposerActions'
import { useComposerDraft } from '../hooks/useComposerDraft'
import { useComposerQueue } from '../hooks/useComposerQueue'
import { useComposerResources } from '../hooks/useComposerResources'
import { ApprovalControl, ContextControl, ModeControl, ModelControl, WorkspaceControl } from './ComposerControls'
import { ComposerQueue, ComposerSelections } from './ComposerFeedback'
import { ComposerQuickMenu, QuickPanel } from './ComposerPanels'
import { filterSkills, messageOf, toggleId, validateAttachments } from './composer-utils'

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

type ComposerPopover = 'quick' | 'approval' | 'mode' | 'workspace' | 'model' | 'context'

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
  const [openPopover, setOpenPopover] = useState<ComposerPopover | null>(null)
  const [quickPanel, setQuickPanel] = useState<QuickPanel | null>(null)
  const [compactProfile, setCompactProfile] = useState(session.profileName)
  const [compacting, setCompacting] = useState(false)
  const [skillQuery, setSkillQuery] = useState('')
  const [referenceQuery, setReferenceQuery] = useState('')
  const [dragActive, setDragActive] = useState(false)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const draft = useComposerDraft(session.id)
  const { skills, connectors, experts, expertTeams, loadSkills, loadConnectors } = useComposerResources({
    workspace: session.workspace,
    setSelectedSkillIds: draft.setSelectedSkillIds,
    setSelectedExpertIds: draft.setSelectedExpertIds,
    setExpertTeamId: draft.setExpertTeamId,
    onNotice: setNotice,
  })
  const queueState = useComposerQueue({ sessions, onSend, onNotice: setNotice })

  const closeQuickMenus = useCallback(() => {
    setOpenPopover(null)
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
    expertTeamId: draft.expertTeamId,
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
  const expertSkills = useMemo(() => experts.map(expert => ({ id: expert.id, name: expert.name, description: expert.description, source: expert.source, pathLabel: expert.skillIds.join(', ') })), [experts])
  const selectedExperts = useMemo(() => expertSkills.filter((expert) => draft.selectedExpertIds.includes(expert.id)), [draft.selectedExpertIds, expertSkills])
  const selectedExpertTeam = useMemo(() => expertTeams.find((team) => team.id === draft.expertTeamId), [draft.expertTeamId, expertTeams])
  const filteredSkills = useMemo(() => filterSkills(skills, skillQuery), [skillQuery, skills])
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
      setOpenPopover(null)
    } catch (error) {
      setNotice(`上下文总结失败：${messageOf(error)}`)
    } finally {
      setCompacting(false)
    }
  }, [busy, compactProfile, compacting, onCompact])

  const pickFiles = useCallback(async () => {
    try {
      const files = await window.ranparty.chooseFileData()
      const attachments = files.map(file => ({ name: file.name, dataUrl: file.dataUrl, size: file.size, mimeType: file.mimeType }))
      validateAttachments(attachments, draft.attachments)
      draft.setAttachments(current => [...current, ...attachments])
    } catch (error) { setNotice(`文件读取失败：${messageOf(error)}`) }
  }, [draft.attachments, draft.setAttachments])

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
    setOpenPopover(null)
    await onPickWorkspace()
  }, [onPickWorkspace])
  const closePopovers = useCallback(() => {
    setOpenPopover(null)
    setQuickPanel(null)
  }, [])
  const changePopover = useCallback((popover: ComposerPopover, value: boolean) => {
    setOpenPopover((current) => value ? popover : current === popover ? null : current)
    if (value && popover !== 'quick') setQuickPanel(null)
  }, [])
  const toggleQuickMenu = useCallback(() => {
    setQuickPanel(null)
    setOpenPopover((current) => current === 'quick' ? null : 'quick')
  }, [])
  const removeAttachment = useCallback((index: number) => draft.setAttachments((current) => current.filter((_, itemIndex) => itemIndex !== index)), [draft.setAttachments])
  const removeExpert = useCallback((id: string) => draft.setSelectedExpertIds((current) => current.filter((item) => item !== id)), [draft.setSelectedExpertIds])
  const removeSkill = useCallback((id: string) => draft.setSelectedSkillIds((current) => current.filter((item) => item !== id)), [draft.setSelectedSkillIds])
  const removeReference = useCallback((id: string) => { void onRemoveSessionReference(id) }, [onRemoveSessionReference])
  const addReference = useCallback((id: string) => { void onAddSessionReference(id) }, [onAddSessionReference])
  const toggleExpert = useCallback((id: string) => {
    draft.setExpertTeamId('')
    draft.setSelectedExpertIds((current) => {
      if (current.includes(id)) return current.filter(item => item !== id)
      if (current.length >= 3) {
        setNotice('最多同时选择 3 位专家；请先移除一位再添加。')
        return current
      }
      return [...current, id]
    })
  }, [draft.setExpertTeamId, draft.setSelectedExpertIds])
  const selectExpertTeam = useCallback((id: string) => {
    if (draft.selectedExpertIds.length) setNotice('专家团与个人专家不能同时使用，已清除个人专家选择。')
    draft.setExpertTeamId(current => current === id ? '' : id)
    draft.setSelectedExpertIds([])
  }, [draft.selectedExpertIds.length, draft.setExpertTeamId, draft.setSelectedExpertIds])
  const toggleSkill = useCallback((id: string) => toggleId(draft.setSelectedSkillIds, id), [draft.setSelectedSkillIds])
  useEffect(() => {
    const addExpert = (event: Event) => {
      const expertId = (event as CustomEvent<{ expertId?: string }>).detail?.expertId
      if (!expertId) return
      draft.setExpertTeamId('')
      draft.setSelectedExpertIds(current => current.includes(expertId) ? current : [...current, expertId].slice(-3))
      setOpenPopover(null); setQuickPanel(null)
    }
    window.addEventListener('ranparty:add-expert', addExpert)
    return () => window.removeEventListener('ranparty:add-expert', addExpert)
  }, [draft.setExpertTeamId, draft.setSelectedExpertIds])
  const changeText = useCallback((event: ChangeEvent<HTMLTextAreaElement>) => draft.setText(event.target.value), [draft.setText])
  useEffect(() => {
    const input = inputRef.current
    if (!input) return
    input.style.height = 'auto'
    input.style.height = `${Math.min(input.scrollHeight, 126)}px`
  }, [draft.text])
  const allowDrop = useCallback((event: DragEvent<HTMLDivElement>) => {
    event.preventDefault()
    if (event.dataTransfer.types.includes('Files')) setDragActive(true)
  }, [])
  const leaveDrop = useCallback((event: DragEvent<HTMLDivElement>) => {
    if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) return
    setDragActive(false)
  }, [])
  const dropFiles = useCallback(async (event: DragEvent<HTMLDivElement>) => {
    setDragActive(false)
    await actions.onDrop(event)
  }, [actions])
  const dismissNotice = useCallback(() => setNotice(''), [])
  const canSubmit = Boolean(session.workspace) && !actions.sending && (Boolean(draft.text.trim()) || draft.attachments.length > 0)

  return <div className="composer-wrap compact-composer-wrap">
    <div className={`composer compact-composer ${busy ? 'busy' : ''} ${dragActive ? 'drag-active' : ''} ${!session.workspace ? 'needs-workspace' : ''}`} onDrop={event => void dropFiles(event)} onDragEnter={allowDrop} onDragOver={allowDrop} onDragLeave={leaveDrop}>
      {dragActive ? <div className="attachment-drop-feedback" role="status"><FilePlus2 size={21} /><strong>松开以添加文件</strong><small>图片、文档、数据文件或源码</small></div> : null}
      <ComposerSelections attachments={draft.attachments} references={selectedReferences} experts={selectedExperts} skills={selectedSkills} expertTeam={selectedExpertTeam} onRemoveAttachment={removeAttachment} onRemoveReference={removeReference} onRemoveExpert={removeExpert} onRemoveSkill={removeSkill} onRemoveExpertTeam={() => draft.setExpertTeamId('')} />
      <ComposerQueue queue={queueState.queue} sessions={sessions} onRetry={queueState.retry} onRemove={queueState.remove} />
      <textarea ref={inputRef} value={draft.text} onChange={changeText} onKeyDown={actions.onKeyDown} onPaste={actions.onPaste} disabled={actions.sending} aria-label="任务消息" placeholder={!session.workspace ? '请先选择工作区' : busy ? '任务运行中：输入后按 Enter 加入队列' : '要求进行后续变更'} rows={1} />
      {busy ? <div className="composer-queue-hint" role="status">当前任务运行中；仍可继续输入，按 Enter 后会排队并在本轮结束后自动发送。</div> : null}
      {session.pendingConfig ? <div className="composer-queue-hint pending-config-hint" role="status">已更新会话设置，将在下一次提问前应用。</div> : null}
      {notice ? <div className="composer-notice inline-notice" role="status">{notice}<button aria-label="关闭输入提示" onClick={dismissNotice}><X size={13} /></button></div> : null}
      <div className="composer-actions">
        <div className="composer-left">
          <div className="popover-anchor composer-add-anchor">
            <button className={`round-icon-button composer-plus ${openPopover === 'quick' ? 'active' : ''}`} onClick={toggleQuickMenu} aria-label="打开输入菜单" aria-haspopup="dialog" aria-expanded={openPopover === 'quick'}><Plus size={19} /></button>
            <button className="round-icon-button muted" onClick={() => void pickFiles()} title="附加文件" aria-label="附加文件"><FileText size={16} /></button>
            {openPopover === 'quick' ? <ComposerQuickMenu activeProfile={activeProfile} hasVisionHelper={hasVisionHelper} canAttachImages={canAttachImages} quickPanel={quickPanel} selectedExpertsCount={selectedExperts.length + (selectedExpertTeam ? 1 : 0)} selectedSkillsCount={selectedSkills.length} referenceItems={referenceOptions} selectedReferenceIds={selectedReferenceIds} referenceQuery={referenceQuery} onReferenceQuery={setReferenceQuery} expertItems={filteredExperts} selectedExpertIds={draft.selectedExpertIds} expertTeams={expertTeams} selectedExpertTeamId={draft.expertTeamId} skillItems={filteredSkills} selectedSkillIds={draft.selectedSkillIds} skillQuery={skillQuery} onSkillQuery={setSkillQuery} connectors={connectors} onChooseImages={actions.chooseImages} onOpenPanel={openPanel} onAddReference={addReference} onToggleExpert={toggleExpert} onSelectExpertTeam={selectExpertTeam} onToggleSkill={toggleSkill} onOpenSkills={onOpenSkills} /> : null}
          </div>
          <ApprovalControl approvalMode={session.approvalMode} disabled={actions.sending} onUpdate={onUpdate} open={openPopover === 'approval'} onOpenChange={(value) => changePopover('approval', value)} />
          <ModeControl currentMode={session.mode ?? 'default'} goalText={session.goal?.text} disabled={actions.sending} onChange={changeMode} open={openPopover === 'mode'} onOpenChange={(value) => changePopover('mode', value)} />
          <WorkspaceControl workspace={session.workspace} workspaces={workspaceOptions} disabled={actions.sending} onUpdate={onUpdate} open={openPopover === 'workspace'} onOpenChange={(value) => changePopover('workspace', value)} onBrowse={pickWorkspace} />
        </div>
        <div className="composer-right">
          <ModelControl session={session} profiles={profiles} disabled={actions.sending} onUpdate={onUpdate} open={openPopover === 'model'} onOpenChange={(value) => changePopover('model', value)} />
          <ContextControl open={openPopover === 'context'} setOpen={(value) => changePopover('context', value)} percentage={percentage} contextUsed={contextUsed} contextWindow={contextWindow} profiles={profiles} compactProfile={compactProfile} setCompactProfile={setCompactProfile} compacting={compacting} busy={busy} onCompact={compact} />
          {busy ? <>
            <button className="round-send-button queue" aria-label="加入发送队列" onClick={actions.send} disabled={!canSubmit} title="加入发送队列"><Send size={16} /></button>
            <button className="round-send-button stop" aria-label={session.turnState === 'cancelling' ? '正在停止当前任务' : '停止当前任务'} disabled={session.turnState === 'cancelling'} onClick={onStop} title={session.turnState === 'cancelling' ? '正在停止…' : '停止生成'}>{session.turnState === 'cancelling' ? <LoaderCircle className="spin" size={15} /> : <Square size={15} />}</button>
          </> : <button className="round-send-button" aria-label="发送消息" onClick={actions.send} disabled={!canSubmit} title="发送"><Send size={17} /></button>}
          {queueState.queue.length > 0 ? <span className="phase-indicator">{queueState.queue.length} 条排队</span> : null}
        </div>
      </div>
    </div>
    <p className="ai-disclaimer">内容由 AI 生成，请核实重要信息</p>
  </div>
}
