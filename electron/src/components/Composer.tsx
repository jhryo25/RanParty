import {
  AtSign,
  Cable,
  Check,
  ChevronDown,
  ChevronRight,
  Circle,
  FilePlus2,
  FolderOpen,
  LoaderCircle,
  Mic,
  Plus,
  Search,
  Send,
  Sparkles,
  Square,
  Users,
  WandSparkles,
  Wrench,
  X,
} from 'lucide-react'
import { ClipboardEvent, Dispatch, DragEvent, KeyboardEvent, ReactNode, SetStateAction, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Attachment, ConnectorConfig, Profile, Session, SessionMode, Skill } from '../types'

const MAX_IMAGES = 8
const MAX_IMAGE_BYTES = 10 * 1024 * 1024

interface Props {
  busy: boolean
  session: Session
  profiles: Profile[]
  workspaces: string[]
  contextUsed: number
  contextWindow: number
  onSend: (text: string, imageDataUrls: string[], skillIds: string[], expertIds: string[]) => Promise<void>
  onStop: () => void
  onUpdate: (patch: Record<string, unknown>) => void
  onPickWorkspace: () => Promise<void>
  onChooseImages: () => Promise<Attachment[]>
  onCompact: (profileName?: string) => Promise<void>
  onOpenSkills?: () => void
  draftText?: string
  phase?: string
  onDraftConsumed?: () => void
}

type QuickPanel = 'reference' | 'mode' | 'experts' | 'skills' | 'connectors'

const modeCopy: Record<SessionMode, { title: string; copy: string }> = {
  default: { title: '默认模式', copy: '可以使用工具，并在确认后完成任务。' },
  plan: { title: 'Plan', copy: '只输出计划，不执行工具或本地副作用。' },
  ask: { title: 'Ask', copy: '只回答问题，不调用工具、不写文件。' },
  goal: { title: 'Goal', copy: '围绕一个持久目标多轮推进，首版保存目标状态。' },
}

export function Composer(props: Props) {
  const {
    busy,
    session,
    profiles,
    workspaces,
    contextUsed,
    contextWindow,
    onSend,
    onStop,
    onUpdate,
    onPickWorkspace,
    onChooseImages,
    onCompact,
    onOpenSkills,
    draftText,
    phase,
    onDraftConsumed,
  } = props
  const [text, setText] = useState('')
  const [attachments, setAttachments] = useState<Attachment[]>([])
  const [skills, setSkills] = useState<Skill[]>([])
  const [selectedSkillIds, setSelectedSkillIds] = useState<string[]>([])
  const [selectedExpertIds, setSelectedExpertIds] = useState<string[]>([])
  const [connectors, setConnectors] = useState<ConnectorConfig[]>([])
  const [quickMenuOpen, setQuickMenuOpen] = useState(false)
  const [quickPanel, setQuickPanel] = useState<QuickPanel | null>(null)
  const [workspaceOpen, setWorkspaceOpen] = useState(false)
  const [contextOpen, setContextOpen] = useState(false)
  const [compactProfile, setCompactProfile] = useState(session.profileName)
  const [compacting, setCompacting] = useState(false)
  const [skillQuery, setSkillQuery] = useState('')
  const [notice, setNotice] = useState('')
  const inputRef = useRef<HTMLTextAreaElement>(null)

  const loadSkills = useCallback(async () => {
    try {
      const result = await window.ranparty.request<{ skills: Skill[] }>('skills.list', { workspace: session.workspace })
      setSkills(result.skills)
    } catch (error) {
      setNotice(`Skill 列表读取失败：${messageOf(error)}`)
      setSkills([])
    }
  }, [session.workspace])

  const loadConnectors = useCallback(async () => {
    try {
      const result = await window.ranparty.request<{ connectors: ConnectorConfig[] }>('connectors.list', {})
      setConnectors(result.connectors)
    } catch {
      setConnectors([])
    }
  }, [])

  useEffect(() => {
    void loadSkills()
    void loadConnectors()
  }, [loadConnectors, loadSkills])

  useEffect(() => {
    const refresh = () => void loadSkills()
    window.addEventListener('ranparty:skills-changed', refresh)
    return () => window.removeEventListener('ranparty:skills-changed', refresh)
  }, [loadSkills])

  useEffect(() => {
    if (!draftText) return
    setText(draftText)
    inputRef.current?.focus()
    onDraftConsumed?.()
  }, [draftText, onDraftConsumed])

  useEffect(() => {
    const closePopovers = (event: PointerEvent) => {
      if (!(event.target as Element | null)?.closest('.popover-anchor')) {
        setQuickMenuOpen(false)
        setQuickPanel(null)
        setWorkspaceOpen(false)
        setContextOpen(false)
      }
    }
    document.addEventListener('pointerdown', closePopovers)
    return () => document.removeEventListener('pointerdown', closePopovers)
  }, [])

  useEffect(() => {
    setQuickMenuOpen(false)
    setQuickPanel(null)
    setWorkspaceOpen(false)
    setContextOpen(false)
    setSelectedSkillIds([])
    setSelectedExpertIds([])
    setCompactProfile(session.profileName)
  }, [session.id, session.profileName])

  const activeProfile = useMemo(() => profiles.find((profile) => profile.name === session.profileName), [profiles, session.profileName])
  const selectedSkills = useMemo(() => skills.filter((skill) => selectedSkillIds.includes(skill.id)), [selectedSkillIds, skills])
  const expertSkills = useMemo(() => skills.filter(isExpertSkill), [skills])
  const selectedExperts = useMemo(() => expertSkills.filter((skill) => selectedExpertIds.includes(skill.id)), [expertSkills, selectedExpertIds])
  const filteredSkills = useMemo(() => filterSkills(skills.filter((skill) => !isExpertSkill(skill)), skillQuery), [skills, skillQuery])
  const filteredExperts = useMemo(() => filterSkills(expertSkills, skillQuery), [expertSkills, skillQuery])
  const workspaceOptions = useMemo(() => {
    const values = [...workspaces]
    if (session.workspace && !values.includes(session.workspace)) values.unshift(session.workspace)
    return values
  }, [session.workspace, workspaces])

  const addAttachments = (items: Attachment[]) => {
    if (!activeProfile?.supportsImages) {
      setNotice('当前模型配置未启用图片输入，请在模型高级配置中开启。')
      return
    }
    const valid = items.filter((item) => {
      if (!item.dataUrl.startsWith('data:image/')) return false
      if ((item.size ?? dataUrlBytes(item.dataUrl)) > MAX_IMAGE_BYTES) {
        setNotice(`${item.name} 超过 10MB，未添加。`)
        return false
      }
      return true
    })
    setAttachments((current) => {
      const room = MAX_IMAGES - current.length
      if (valid.length > room) setNotice(`最多附加 ${MAX_IMAGES} 张图片。`)
      return [...current, ...valid.slice(0, Math.max(0, room))]
    })
  }

  const choose = async () => addAttachments(await onChooseImages())
  const send = async () => {
    let value = text.trim()
    if (busy || !session.workspace || (!value && attachments.length === 0)) return

    // Slash commands: /plan /ask /default /goal
    const slashMatch = value.match(/^\/(plan|ask|default|goal)\b\s*(.*)/i)
    if (slashMatch) {
      const [, cmd, rest] = slashMatch
      const mode = cmd.toLowerCase() as SessionMode
      if (mode === 'goal') {
        const goalText = rest || window.prompt('Goal mode target?')?.trim()
        if (!goalText) return
        await onUpdate({ mode, goal: { text: goalText, status: 'active' } })
        value = goalText
      } else {
        await onUpdate({ mode })
        value = rest || ''
      }
      if (!value && attachments.length === 0) { setText(''); inputRef.current?.focus(); return }
    }

    await onSend(value, attachments.map((item) => item.dataUrl), selectedSkillIds, selectedExpertIds)
    setText('')
    setAttachments([])
    setSelectedSkillIds([])
    setSelectedExpertIds([])
    setQuickMenuOpen(false)
    setQuickPanel(null)
    setNotice('')
    inputRef.current?.focus()
  }

  const keyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      void send()
    }
  }

  const paste = async (event: ClipboardEvent<HTMLTextAreaElement>) => {
    const files = [...event.clipboardData.files].filter((file) => file.type.startsWith('image/'))
    if (!files.length) return
    event.preventDefault()
    addAttachments(await filesToAttachments(files))
  }

  const drop = async (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault()
    const files = [...event.dataTransfer.files].filter((file) => file.type.startsWith('image/'))
    if (files.length) addAttachments(await filesToAttachments(files))
  }

  const percentage = Number.isNaN(contextUsed) || Number.isNaN(contextWindow)
    ? 0
    : Math.min(100, Math.round((contextUsed / Math.max(1, contextWindow)) * 100))

  const compact = async () => {
    if (compacting || busy) return
    setCompacting(true)
    try {
      await onCompact(compactProfile)
      setContextOpen(false)
    } finally {
      setCompacting(false)
    }
  }

  const changeMode = (mode: SessionMode) => {
    if (mode === 'goal') {
      const current = session.goal?.text ?? ''
      const goal = window.prompt('Goal 模式目标是什么？', current)?.trim()
      if (!goal) return
      onUpdate({ mode, goal: { text: goal, status: 'active' } })
      return
    }
    onUpdate({ mode })
  }

  const openPanel = (panel: QuickPanel) => {
    setQuickPanel(panel)
    if (panel === 'skills' || panel === 'experts') void loadSkills()
    if (panel === 'connectors') void loadConnectors()
  }

  const pickWorkspace = async () => {
    setWorkspaceOpen(false)
    await onPickWorkspace()
  }

  const canSend = Boolean(session.workspace) && !busy && (Boolean(text.trim()) || attachments.length > 0)
  const currentMode = session.mode ?? 'default'

  return (
    <div className="composer-wrap compact-composer-wrap">
      <div
        className={`composer compact-composer ${busy ? 'busy' : ''} ${!session.workspace ? 'needs-workspace' : ''}`}
        onDrop={(event) => void drop(event)}
        onDragOver={(event) => event.preventDefault()}
      >
        {attachments.length || selectedSkills.length || selectedExperts.length ? (
          <div className="composer-attachments">
            {attachments.map((attachment, index) => (
              <div className="image-preview" key={`${attachment.name}-${index}`}>
                <img src={attachment.dataUrl} alt={attachment.name} />
                <button onClick={() => setAttachments((current) => current.filter((_, itemIndex) => itemIndex !== index))} aria-label={`移除 ${attachment.name}`}><X size={13} /></button>
              </div>
            ))}
            {selectedExperts.map((skill) => <Chip key={skill.id} label={`专家：${skill.name}`} onRemove={() => setSelectedExpertIds((current) => current.filter((id) => id !== skill.id))} />)}
            {selectedSkills.map((skill) => <Chip key={skill.id} label={`技能：${skill.name}`} onRemove={() => setSelectedSkillIds((current) => current.filter((id) => id !== skill.id))} />)}
          </div>
        ) : null}

        <textarea
          ref={inputRef}
          value={text}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={keyDown}
          onPaste={(event) => void paste(event)}
          placeholder={session.workspace ? '要求进行后续变更' : '请先选择工作区'}
          rows={1}
        />

        {notice ? <div className="composer-notice inline-notice">{notice}<button onClick={() => setNotice('')}><X size={13} /></button></div> : null}

        <div className="composer-actions">
          <div className="composer-left">
            <div className="popover-anchor">
              <button
                className={`round-icon-button composer-plus ${quickMenuOpen ? 'active' : ''}`}
                onClick={() => {
                  const opening = !quickMenuOpen
                  setQuickMenuOpen(opening)
                  setQuickPanel(null)
                  setWorkspaceOpen(false)
                  setContextOpen(false)
                }}
                aria-label="打开输入菜单"
              >
                <Plus size={19} />
              </button>
              {quickMenuOpen ? (
                <div className="composer-menu-shell compact-menu-shell">
                  <div className="control-popover composer-command-menu">
                    <MenuButton icon={<FilePlus2 size={16} />} title="添加文件" copy={activeProfile?.supportsImages ? '添加或粘贴图片附件' : '当前模型未启用图片输入'} onClick={() => void choose()} disabled={!activeProfile?.supportsImages} />
                    <MenuButton icon={<AtSign size={16} />} title="引用对话中的文件" copy="从产物或工作区文件引用" panel="reference" active={quickPanel === 'reference'} onHover={openPanel} />
                    <hr />
                    <MenuButton icon={<Users size={16} />} title="专家" copy={selectedExperts.length ? `已选择 ${selectedExperts.length} 个专家` : '选择 Skill 广场专家套件'} panel="experts" active={quickPanel === 'experts'} onHover={openPanel} />
                    <MenuButton icon={<Wrench size={16} />} title="技能" copy={selectedSkills.length ? `已选择 ${selectedSkills.length} 个技能` : '显式选择，仅注入下一次发送'} panel="skills" active={quickPanel === 'skills'} onHover={openPanel} />
                    <MenuButton icon={<Cable size={16} />} title="连接器" copy="MCP server 与内置工具权限" panel="connectors" active={quickPanel === 'connectors'} onHover={openPanel} />
                  </div>
                  {quickPanel ? (
                    <div className="control-popover composer-command-submenu">
                      {quickPanel === 'reference' ? <ReferencePanel /> : null}
                      {quickPanel === 'experts' ? <SkillPickPanel title="可用专家套件" empty="尚未安装专家套件。请到 Skill 广场安装 Soul / Pack。" items={filteredExperts} selected={selectedExpertIds} query={skillQuery} setQuery={setSkillQuery} onOpenSkills={onOpenSkills} onToggle={(id) => toggleId(setSelectedExpertIds, id)} /> : null}
                      {quickPanel === 'skills' ? <SkillPickPanel title="可用技能" empty="没有找到可用 Skill。请先到 Skill 广场安装，或检查 Skill 是否包含 SKILL.md。" items={filteredSkills} selected={selectedSkillIds} query={skillQuery} setQuery={setSkillQuery} onOpenSkills={onOpenSkills} onToggle={(id) => toggleId(setSelectedSkillIds, id)} /> : null}
                      {quickPanel === 'connectors' ? <ConnectorPanel connectors={connectors} /> : null}
                    </div>
                  ) : null}
                </div>
              ) : null}
            </div>

            <ApprovalControl approvalMode={session.approvalMode} onUpdate={onUpdate} />
            <ModeControl currentMode={currentMode} goalText={session.goal?.text} onChange={changeMode} />
            <WorkspaceControl workspace={session.workspace} workspaces={workspaceOptions} onUpdate={onUpdate} open={workspaceOpen} setOpen={setWorkspaceOpen} onBrowse={pickWorkspace} />
          </div>

          <div className="composer-right">
            <ModelControl session={session} profiles={profiles} onUpdate={onUpdate} />
            <ContextControl
              open={contextOpen}
              setOpen={setContextOpen}
              percentage={percentage}
              contextUsed={contextUsed}
              contextWindow={contextWindow}
              profiles={profiles}
              compactProfile={compactProfile}
              setCompactProfile={setCompactProfile}
              compacting={compacting}
              busy={busy}
              onCompact={compact}
            />
            <button className="round-icon-button muted" title="语音输入暂未启用"><Mic size={16} /></button>
            {busy
              ? <button className="round-send-button stop" onClick={onStop} title="停止生成"><Square size={15} /></button>
              : <button className="round-send-button" onClick={() => void send()} disabled={!canSend} title="发送"><Send size={17} /></button>}
            {phase && busy ? <span className="phase-indicator">{phase}</span> : null}
          </div>
        </div>
      </div>
      <p className="ai-disclaimer">内容由 AI 生成，请核实重要信息</p>
    </div>
  )
}

function Chip({ label, onRemove }: { label: string; onRemove: () => void }) {
  return <div className="skill-chip"><Sparkles size={13} /><span>{label}</span><button onClick={onRemove}><X size={13} /></button></div>
}

function ApprovalControl({ approvalMode, onUpdate }: { approvalMode: Session['approvalMode']; onUpdate: (patch: Record<string, unknown>) => void }) {
  return <div className="popover-anchor approval-anchor">
    <button className="mini-select" type="button" title="审批模式">
      <span>{approvalMode === 'auto' ? '自动通过' : '请求批准'}</span>
      <ChevronDown size={13} />
    </button>
    <div className="mini-hover-menu">
      <button onClick={() => onUpdate({ approvalMode: 'ask' })}><Check size={13} className={approvalMode === 'ask' ? '' : 'invisible'} />请求批准</button>
      <button onClick={() => onUpdate({ approvalMode: 'auto' })}><Check size={13} className={approvalMode === 'auto' ? '' : 'invisible'} />自动通过</button>
    </div>
  </div>
}

function ModeControl({ currentMode, goalText, onChange }: { currentMode: SessionMode; goalText?: string; onChange: (mode: SessionMode) => void }) {
  return <div className="popover-anchor mode-anchor">
    <button className="mini-select mode-mini" type="button" title="模式">
      <WandSparkles size={13} />
      <span>{modeCopy[currentMode].title}</span>
      <ChevronDown size={13} />
    </button>
    <div className="mini-hover-menu mode-hover-menu">
      {(['default', 'plan', 'ask', 'goal'] as SessionMode[]).map((mode) => (
        <button key={mode} onClick={() => onChange(mode)} className={currentMode === mode ? 'selected' : ''}>
          {currentMode === mode ? <Check size={13} /> : <Circle size={13} />}
          <span>{modeCopy[mode].title}<small>{mode === 'goal' && goalText ? goalText : modeCopy[mode].copy}</small></span>
        </button>
      ))}
    </div>
  </div>
}

function WorkspaceControl({ workspace, workspaces, onUpdate, open, setOpen, onBrowse }: {
  workspace: string
  workspaces: string[]
  onUpdate: (patch: Record<string, unknown>) => void
  open: boolean
  setOpen: (value: boolean) => void
  onBrowse: () => Promise<void>
}) {
  return <div className="popover-anchor workspace-anchor">
    <button type="button" className={`mini-select workspace-mini ${!workspace ? 'required' : ''}`} onClick={() => setOpen(!open)}>
      <FolderOpen size={14} />
      <span>{workspace ? workspaceName(workspace) : '选择工作区'}</span>
      <ChevronDown size={13} />
    </button>
    {open ? <div className="control-popover compact-workspace-popover">
      <div className="popover-title"><strong>工作区</strong></div>
      <div className="popover-list">
        {workspaces.map((item) => (
          <button className="workspace-option" key={item} onClick={() => { onUpdate({ workspace: item }); setOpen(false) }}>
            <FolderOpen size={15} />
            <span><strong>{workspaceName(item)}</strong><small>{item}</small></span>
            {item === workspace ? <Check size={15} /> : null}
          </button>
        ))}
        <button className="workspace-option browse" onClick={() => void onBrowse()}>
          <FolderOpen size={15} />
          <span><strong>浏览文件夹…</strong><small>选择本机目录作为工作区</small></span>
        </button>
      </div>
    </div> : null}
  </div>
}

function ModelControl({ session, profiles, onUpdate }: { session: Session; profiles: Profile[]; onUpdate: (patch: Record<string, unknown>) => void }) {
  return <div className="popover-anchor model-anchor">
    <button className="mini-select model-mini" type="button" title="模型">
      <span>{session.profileName}</span>
      <ChevronDown size={13} />
    </button>
    <div className="mini-hover-menu model-menu">
      {profiles.map((profile) => (
        <button key={profile.name} onClick={() => onUpdate({ profileName: profile.name })}>
          <Check size={13} className={profile.name === session.profileName ? '' : 'invisible'} />
          <span>{profile.name}<small>{profile.model}</small></span>
        </button>
      ))}
    </div>
  </div>
}

function MenuButton({ icon, title, copy, panel, active, disabled, onHover, onClick }: {
  icon: ReactNode
  title: string
  copy: string
  panel?: QuickPanel
  active?: boolean
  disabled?: boolean
  onHover?: (panel: QuickPanel) => void
  onClick?: () => void
}) {
  return <button
    type="button"
    className={`${active ? 'active' : ''} ${disabled ? 'disabled' : ''}`}
    disabled={disabled}
    onMouseEnter={() => panel && onHover?.(panel)}
    onClick={() => panel ? onHover?.(panel) : onClick?.()}
  >
    {icon}<span><strong>{title}</strong><small>{copy}</small></span>{panel ? <ChevronRight size={14} /> : null}
  </button>
}

function ReferencePanel() {
  return <div className="mode-panel">
    <p>引用文件会从右侧“产物 / 工作区文件”选择内容作为上下文。首版保留入口，文件选择器将在右侧栏联动后启用。</p>
    <button type="button" className="toggle-row disabled"><span><strong>暂无可引用文件</strong><small>打开右侧文件或产物后可从这里引用</small></span><Circle size={16} /></button>
  </div>
}

function SkillPickPanel({ title, empty, items, selected, query, setQuery, onToggle, onOpenSkills }: {
  title: string
  empty: string
  items: Skill[]
  selected: string[]
  query: string
  setQuery: (value: string) => void
  onToggle: (id: string) => void
  onOpenSkills?: () => void
}) {
  return <>
    <label className="submenu-search"><Search size={15} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={`搜索${title.replace('可用', '')}`} /></label>
    <div className="submenu-title">{title}</div>
    <div className="popover-list compact">
      {items.map((skill) => {
        const checked = selected.includes(skill.id)
        return <button className={`skill-option ${checked ? 'selected' : ''}`} key={skill.id} onClick={() => onToggle(skill.id)}>
          <span className="check-box">{checked ? <Check size={13} /> : null}</span>
          <span><strong>{skill.name}</strong><small>{skill.description || skill.pathLabel}</small><em>{skill.source}</em></span>
        </button>
      })}
      {items.length === 0 ? <p className="popover-empty">{empty}</p> : null}
    </div>
    <div className="submenu-footer"><button type="button" onClick={onOpenSkills}>打开 Skill 广场</button></div>
  </>
}

function ConnectorPanel({ connectors }: { connectors: ConnectorConfig[] }) {
  return <div className="mode-panel connector-panel">
    <p>连接器按 MCP server 思路管理：默认不向模型暴露危险工具，需要先启用 server，再按工具允许列表开放。</p>
    {connectors.length ? connectors.map((connector) => (
      <button type="button" className="toggle-row" key={connector.id}>
        <span><strong>{connector.name}</strong><small>{connector.type} · {connectorStatus(connector)}</small></span>
        <Circle size={16} />
      </button>
    )) : <button type="button" className="toggle-row disabled"><span><strong>暂无连接器</strong><small>前往设置或后续连接器管理页新增 MCP server</small></span><Circle size={16} /></button>}
  </div>
}

function ContextControl({ open, setOpen, percentage, contextUsed, contextWindow, profiles, compactProfile, setCompactProfile, compacting, busy, onCompact }: {
  open: boolean
  setOpen: (value: boolean) => void
  percentage: number
  contextUsed: number
  contextWindow: number
  profiles: Profile[]
  compactProfile: string
  setCompactProfile: (value: string) => void
  compacting: boolean
  busy: boolean
  onCompact: () => void
}) {
  return <div className="popover-anchor context-anchor">
    <button className="context-ring-button" onClick={() => setOpen(!open)} aria-label={`上下文已使用 ${percentage}%`}>
      <svg className="context-ring" viewBox="0 0 36 36" aria-hidden="true"><circle className="context-ring-track" cx="18" cy="18" r="14" /><circle className="context-ring-value" cx="18" cy="18" r="14" pathLength="100" strokeDasharray={`${percentage} 100`} /></svg>
      <span>{percentage}</span>
      <span className="context-tooltip">已使用 {formatTokens(contextUsed)} / {formatTokens(contextWindow)} Token（{percentage}%）</span>
    </button>
    {open ? <div className="control-popover context-popover">
      <div className="context-popover-head"><div><strong>上下文</strong><span>{formatTokens(contextUsed)} / {formatTokens(contextWindow)} Token</span></div><b>{percentage}%</b></div>
      <div className="context-progress"><span style={{ width: `${percentage}%` }} /></div>
      <p>提前总结会压缩发给模型的历史上下文；完整聊天记录仍会保留。</p>
      <label><span>总结模型</span><select value={compactProfile} onChange={(event) => setCompactProfile(event.target.value)}>{profiles.map((profile) => <option key={profile.name} value={profile.name}>{profile.name} · {profile.model}</option>)}</select></label>
      <button className="compact-button" disabled={compacting || busy || contextUsed === 0} onClick={onCompact}>{compacting ? <LoaderCircle className="spin" size={15} /> : <Sparkles size={15} />}{compacting ? '正在总结…' : '立即总结上下文'}</button>
    </div> : null}
  </div>
}

async function filesToAttachments(files: File[]): Promise<Attachment[]> {
  return Promise.all(files.map((file) => new Promise<Attachment>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve({ name: file.name || `粘贴图片-${Date.now()}.png`, dataUrl: String(reader.result), size: file.size })
    reader.onerror = () => reject(reader.error ?? new Error('文件读取失败'))
    reader.readAsDataURL(file)
  })))
}

function toggleId(setter: Dispatch<SetStateAction<string[]>>, id: string) {
  setter((current) => current.includes(id) ? current.filter((item) => item !== id) : [...current, id])
}

function filterSkills(items: Skill[], query: string) {
  const normalized = query.trim().toLocaleLowerCase()
  if (!normalized) return items
  return items.filter((skill) => `${skill.name} ${skill.description} ${skill.source} ${skill.pathLabel}`.toLocaleLowerCase().includes(normalized))
}

function isExpertSkill(skill: Skill) {
  const value = `${skill.source} ${skill.pathLabel} ${skill.name}`.toLocaleLowerCase()
  return value.includes('soul') || value.includes('pack') || value.includes('expert') || value.includes('专家')
}

function connectorStatus(connector: ConnectorConfig) {
  if (!connector.enabled) return '未启用'
  if (connector.status === 'connected') return '已连接'
  if (connector.status === 'failed') return `启动失败：${connector.lastError || '未知错误'}`
  if (connector.status === 'not_configured') return '需要配置'
  return '未连接'
}

function dataUrlBytes(value: string) { return Math.ceil((value.split(',')[1]?.length ?? 0) * 3 / 4) }
function workspaceName(value: string) { return value.split(/[\\/]/).filter(Boolean).at(-1) ?? value }
function formatTokens(value: number) { return value >= 1000 ? `${(value / 1000).toFixed(value >= 10000 ? 0 : 1)}K` : `${value}` }
function messageOf(reason: unknown) { return reason instanceof Error ? reason.message : String(reason) }
