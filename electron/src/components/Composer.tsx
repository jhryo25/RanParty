import { AtSign, Bot, BriefcaseBusiness, Cable, Check, ChevronDown, ChevronRight, Circle, FilePlus2, FolderOpen, LoaderCircle, Plus, Search, Send, Settings, ShieldCheck, Sparkles, Square, Users, WandSparkles, Wrench, X } from 'lucide-react'
import { ClipboardEvent, DragEvent, KeyboardEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Attachment, Profile, Session, Skill } from '../types'

const MAX_IMAGES = 8
const MAX_IMAGE_BYTES = 10 * 1024 * 1024

interface Props {
  busy: boolean
  session: Session
  profiles: Profile[]
  workspaces: string[]
  contextUsed: number
  contextWindow: number
  onSend: (text: string, imageDataUrls: string[], skillIds: string[]) => Promise<void>
  onStop: () => void
  onUpdate: (patch: Record<string, unknown>) => void
  onPickWorkspace: () => Promise<void>
  onChooseImages: () => Promise<Attachment[]>
  onCompact: (profileName?: string) => Promise<void>
}

type QuickPanel = 'skills' | 'experts' | 'mode' | 'permissions' | 'models' | 'connectors'

export function Composer(props: Props) {
  const { busy, session, profiles, workspaces, contextUsed, contextWindow, onSend, onStop, onUpdate, onPickWorkspace, onChooseImages, onCompact } = props
  const [text, setText] = useState('')
  const [attachments, setAttachments] = useState<Attachment[]>([])
  const [skills, setSkills] = useState<Skill[]>([])
  const [selectedSkillIds, setSelectedSkillIds] = useState<string[]>([])
  const [quickMenuOpen, setQuickMenuOpen] = useState(false)
  const [quickPanel, setQuickPanel] = useState<QuickPanel>('skills')
  const [skillOpen, setSkillOpen] = useState(false)
  const [workspaceOpen, setWorkspaceOpen] = useState(false)
  const [contextOpen, setContextOpen] = useState(false)
  const [compactProfile, setCompactProfile] = useState(session.profileName)
  const [compacting, setCompacting] = useState(false)
  const [skillQuery, setSkillQuery] = useState('')
  const [notice, setNotice] = useState('')
  const inputRef = useRef<HTMLTextAreaElement>(null)

  const loadSkills = useCallback(async () => {
    let cancelled = false
    window.ranparty.request<{ skills: Skill[] }>('skills.list', { workspace: session.workspace })
      .then((result) => { if (!cancelled) setSkills(result.skills) })
      .catch((error) => { if (!cancelled) setNotice(String(error)) })
    return () => { cancelled = true }
  }, [session.workspace])

  useEffect(() => {
    void loadSkills()
  }, [loadSkills])

  useEffect(() => {
    const closePopovers = (event: PointerEvent) => {
      if (!(event.target as Element | null)?.closest('.popover-anchor')) {
        setSkillOpen(false)
        setQuickMenuOpen(false)
        setWorkspaceOpen(false)
        setContextOpen(false)
      }
    }
    document.addEventListener('pointerdown', closePopovers)
    return () => document.removeEventListener('pointerdown', closePopovers)
  }, [])

  useEffect(() => {
    setSkillOpen(false)
    setQuickMenuOpen(false)
    setWorkspaceOpen(false)
    setContextOpen(false)
    setCompactProfile(session.profileName)
  }, [session.id])

  useEffect(() => setCompactProfile(session.profileName), [session.profileName])

  const selectedSkills = useMemo(() => {
    const selected = new Set(selectedSkillIds)
    return skills.filter((skill) => selected.has(skill.id))
  }, [selectedSkillIds, skills])
  const filteredSkills = useMemo(() => {
    const query = skillQuery.trim().toLocaleLowerCase()
    return query ? skills.filter((skill) => `${skill.name} ${skill.description} ${skill.source}`.toLocaleLowerCase().includes(query)) : skills
  }, [skills, skillQuery])
  const activeProfile = useMemo(() => profiles.find((profile) => profile.name === session.profileName), [profiles, session.profileName])
  const expertOptions = useMemo(() => {
    const names = profiles.map((profile) => profile.characterDisplayName || profile.characterCard || profile.name).filter(Boolean)
    return [...new Set(names)]
  }, [profiles])

  const addAttachments = (items: Attachment[]) => {
    if (!activeProfile?.supportsImages) { setNotice('当前模型配置未启用图片输入，请在模型高级配置中开启'); return }
    const valid = items.filter((item) => {
      if (!item.dataUrl.startsWith('data:image/')) return false
      if ((item.size ?? dataUrlBytes(item.dataUrl)) > MAX_IMAGE_BYTES) {
        setNotice(`${item.name} 超过 10MB，未添加`)
        return false
      }
      return true
    })
    setAttachments((current) => {
      const room = MAX_IMAGES - current.length
      if (valid.length > room) setNotice(`一次最多添加 ${MAX_IMAGES} 张图片`)
      return [...current, ...valid.slice(0, Math.max(0, room))]
    })
  }

  const choose = async () => addAttachments(await onChooseImages())
  const send = async () => {
    const value = text.trim()
    if (busy || !session.workspace || (!value && attachments.length === 0)) return
    await onSend(value, attachments.map((item) => item.dataUrl), selectedSkillIds)
    setText('')
    setAttachments([])
    setSelectedSkillIds([])
    setQuickMenuOpen(false)
    setSkillOpen(false)
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
    if (files.length === 0) return
    event.preventDefault()
    addAttachments(await filesToAttachments(files))
  }
  const drop = async (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault()
    const files = [...event.dataTransfer.files].filter((file) => file.type.startsWith('image/'))
    if (files.length) addAttachments(await filesToAttachments(files))
  }
  const percentage = Number.isNaN(contextUsed) || Number.isNaN(contextWindow) ? 0 : Math.min(100, Math.round((contextUsed / Math.max(1, contextWindow)) * 100))
  const compact = async () => {
    if (compacting || busy) return
    setCompacting(true)
    try { await onCompact(compactProfile); setContextOpen(false); setNotice('上下文已总结，完整聊天记录仍会保留。') }
    catch { /* App 会展示后端错误 */ }
    finally { setCompacting(false) }
  }
  const canSend = Boolean(session.workspace) && !busy && (Boolean(text.trim()) || attachments.length > 0)
  const showQuickPanel = (panel: QuickPanel) => {
    setQuickPanel(panel)
    if (panel === 'skills') void loadSkills()
  }

  return (
    <div className="composer-wrap">
      <div className={`composer ${busy ? 'busy' : ''} ${!session.workspace ? 'needs-workspace' : ''}`} onDrop={(event) => void drop(event)} onDragOver={(event) => event.preventDefault()}>
        {attachments.length || selectedSkills.length ? (
          <div className="composer-attachments">
            {attachments.map((attachment, index) => (
              <div className="image-preview" key={`${attachment.name}-${index}`}>
                <img src={attachment.dataUrl} alt={attachment.name} />
                <button onClick={() => setAttachments((current) => current.filter((_, itemIndex) => itemIndex !== index))} aria-label={`移除 ${attachment.name}`}><X size={13} /></button>
              </div>
            ))}
            {selectedSkills.map((skill) => (
              <div className="skill-chip" key={skill.id}><BriefcaseBusiness size={14} /><span>${skill.name}</span><button onClick={() => setSelectedSkillIds((current) => current.filter((id) => id !== skill.id))}><X size={13} /></button></div>
            ))}
          </div>
        ) : null}
        <textarea
          ref={inputRef}
          value={text}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={keyDown}
          onPaste={(event) => void paste(event)}
          placeholder={session.workspace ? '输入消息，Shift + Enter 换行，Enter 发送' : '请先在下方选择工作区'}
          rows={3}
        />
        {notice ? <div className="composer-notice">{notice}<button onClick={() => setNotice('')}><X size={13} /></button></div> : null}
        <div className="composer-actions">
          <div className="composer-left">
            <div className="popover-anchor">
              <button className={`square-button composer-plus ${quickMenuOpen || selectedSkillIds.length ? 'active' : ''}`} onClick={() => { const opening = !quickMenuOpen; setQuickMenuOpen(opening); if (opening) { setQuickPanel('skills'); void loadSkills() } setSkillOpen(false); setWorkspaceOpen(false); setContextOpen(false) }} aria-label="打开输入菜单"><Plus size={20} /></button>
              {quickMenuOpen ? (
                <div className="composer-menu-shell">
                  <div className="control-popover composer-command-menu">
                    <button onClick={() => void choose()} disabled={!activeProfile?.supportsImages}><FilePlus2 size={16} /><span><strong>添加文件</strong><small>{activeProfile?.supportsImages ? '添加或粘贴图片附件' : '当前模型未启用图片输入'}</small></span><ChevronRight size={14} /></button>
                    <button type="button" className="disabled"><AtSign size={16} /><span><strong>引用对话中的文件</strong><small>从右侧产物或工作区文件引用</small></span><ChevronRight size={14} /></button>
                    <hr />
                    <button type="button" className={quickPanel === 'mode' ? 'active' : ''} onMouseEnter={() => showQuickPanel('mode')} onClick={() => showQuickPanel('mode')}><WandSparkles size={16} /><span><strong>模式</strong><small>默认执行，可扩展计划/仅问答</small></span><ChevronRight size={14} /></button>
                    <button type="button" className={quickPanel === 'experts' ? 'active' : ''} onMouseEnter={() => showQuickPanel('experts')} onClick={() => showQuickPanel('experts')}><Users size={16} /><span><strong>专家</strong><small>选择角色卡对应专家</small></span><ChevronRight size={14} /></button>
                    <button type="button" className={quickPanel === 'skills' ? 'active' : ''} onMouseEnter={() => showQuickPanel('skills')} onClick={() => showQuickPanel('skills')}><Wrench size={16} /><span><strong>技能</strong><small>{selectedSkills.length ? `已选择 ${selectedSkills.length} 个` : '显式选择，仅注入下一次发送'}</small></span><ChevronRight size={14} /></button>
                    <button type="button" className={quickPanel === 'connectors' ? 'active' : ''} onMouseEnter={() => showQuickPanel('connectors')} onClick={() => showQuickPanel('connectors')}><Cable size={16} /><span><strong>连接器</strong><small>联网、文件与 Shell 能力</small></span><ChevronRight size={14} /></button>
                    <hr />
                    <button type="button" className={quickPanel === 'permissions' ? 'active' : ''} onMouseEnter={() => showQuickPanel('permissions')} onClick={() => showQuickPanel('permissions')}><ShieldCheck size={16} /><span><strong>{session.approvalMode === 'auto' ? '自动通过' : '默认权限'}</strong><small>控制工具执行是否需要确认</small></span><ChevronRight size={14} /></button>
                    <button type="button" className={quickPanel === 'models' ? 'active' : ''} onMouseEnter={() => showQuickPanel('models')} onClick={() => showQuickPanel('models')}><Settings size={16} /><span><strong>{activeProfile?.model || session.model}</strong><small>切换当前会话模型</small></span><ChevronRight size={14} /></button>
                  </div>
                  <div className="control-popover composer-command-submenu">
                    {quickPanel === 'skills' ? <>
                      <label className="submenu-search"><Search size={15} /><input value={skillQuery} onChange={(event) => setSkillQuery(event.target.value)} placeholder="搜索技能" /></label>
                      <div className="popover-list compact">
                        {filteredSkills.map((skill) => {
                          const checked = selectedSkillIds.includes(skill.id)
                          return <button className={`skill-option ${checked ? 'selected' : ''}`} key={skill.id} onClick={() => setSelectedSkillIds((current) => checked ? current.filter((id) => id !== skill.id) : [...current, skill.id])}><span className="check-box">{checked ? <Check size={13} /> : null}</span><span><strong>{skill.name}</strong><small>{skill.description || skill.pathLabel}</small><em>{skill.source}</em></span></button>
                        })}
                        {filteredSkills.length === 0 ? <p className="popover-empty">没有找到可用 Skill</p> : null}
                      </div>
                      <div className="submenu-footer"><button type="button" className="disabled">从本地添加技能</button><button type="button" className="disabled">管理技能</button></div>
                    </> : null}
                    {quickPanel === 'experts' ? <>
                      <div className="submenu-title">可用专家</div>
                      <div className="popover-list compact">
                        {expertOptions.map((name) => {
                          const profile = profiles.find((item) => (item.characterDisplayName || item.characterCard || item.name) === name)
                          const active = profile?.name === session.profileName
                          return <button className={`submenu-row ${active ? 'selected' : ''}`} key={name} onClick={() => profile ? onUpdate({ profileName: profile.name }) : undefined}><Bot size={16} /><span><strong>{name}</strong><small>{profile ? `${profile.name} · ${profile.model}` : '角色卡专家'}</small></span>{active ? <Check size={14} /> : null}</button>
                        })}
                      </div>
                      <div className="submenu-footer"><button type="button" className="disabled">召唤更多专家</button></div>
                    </> : null}
                    {quickPanel === 'mode' ? <div className="mode-panel">
                      <p>当前为默认模式：可高效执行并完成任务。</p>
                      <button type="button" className="toggle-row disabled"><span><strong>计划 Plan</strong><small>后端模式扩展后启用</small></span><Circle size={16} /></button>
                      <button type="button" className="toggle-row disabled"><span><strong>仅问答 Ask</strong><small>后端模式扩展后启用</small></span><Circle size={16} /></button>
                    </div> : null}
                    {quickPanel === 'permissions' ? <div className="mode-panel">
                      <p>{session.approvalMode === 'auto' ? '工具执行会自动通过。高风险操作仍会受后端安全策略限制。' : '默认权限下，工具执行会请求你的确认。'}</p>
                      <button type="button" className={`toggle-row ${session.approvalMode === 'ask' ? 'selected' : ''}`} onClick={() => onUpdate({ approvalMode: 'ask' })}><span><strong>每步确认</strong><small>适合不确定任务或敏感目录</small></span>{session.approvalMode === 'ask' ? <Check size={16} /> : <Circle size={16} />}</button>
                      <button type="button" className={`toggle-row ${session.approvalMode === 'auto' ? 'selected' : ''}`} onClick={() => onUpdate({ approvalMode: 'auto' })}><span><strong>自动通过</strong><small>适合低风险连续任务</small></span>{session.approvalMode === 'auto' ? <Check size={16} /> : <Circle size={16} />}</button>
                    </div> : null}
                    {quickPanel === 'models' ? <>
                      <div className="submenu-title">选择模型</div>
                      <div className="popover-list compact">
                        {profiles.map((profile) => {
                          const active = profile.name === session.profileName
                          return <button className={`submenu-row ${active ? 'selected' : ''}`} key={profile.name} onClick={() => { onUpdate({ profileName: profile.name }); setQuickMenuOpen(false) }}><span className="model-mark">{profile.model.slice(0, 1).toUpperCase()}</span><span><strong>{profile.name}</strong><small>{profile.model} · {profile.provider === 'anthropic' ? 'Anthropic' : 'OpenAI'} · {profile.supportsImages ? '支持图片' : '文本'}</small></span>{active ? <Check size={14} /> : null}</button>
                        })}
                      </div>
                      <div className="submenu-footer"><button type="button" className="disabled">配置自定义模型</button></div>
                    </> : null}
                    {quickPanel === 'connectors' ? <div className="mode-panel">
                      <p>连接器会作为工具能力暴露给 AI；当前会话实际可用能力由模型配置和后端工具策略决定。</p>
                      <button type="button" className="toggle-row disabled"><span><strong>联网查询</strong><small>{activeProfile?.supportsTools ? '模型支持工具调用时可用' : '当前模型未启用工具调用'}</small></span><Circle size={16} /></button>
                      <button type="button" className="toggle-row disabled"><span><strong>工作区文件</strong><small>{session.workspace ? session.workspace : '请先选择工作区'}</small></span><Circle size={16} /></button>
                      <button type="button" className="toggle-row disabled"><span><strong>Shell / PowerShell</strong><small>受审批模式和白名单限制</small></span><Circle size={16} /></button>
                    </div> : null}
                  </div>
                </div>
              ) : null}
            </div>
          </div>
          <div className="composer-right">
            <div className="popover-anchor context-anchor">
              <button className="context-ring-button" onClick={() => { setContextOpen((value) => !value); setQuickMenuOpen(false); setSkillOpen(false); setWorkspaceOpen(false) }} aria-label={`上下文已使用 ${percentage}%`}>
                <svg className="context-ring" viewBox="0 0 36 36" aria-hidden="true"><circle className="context-ring-track" cx="18" cy="18" r="14" /><circle className="context-ring-value" cx="18" cy="18" r="14" pathLength="100" strokeDasharray={`${percentage} 100`} /></svg>
                <span>{percentage}</span>
                <span className="context-tooltip">已使用 {formatTokens(contextUsed)} / {formatTokens(contextWindow)} Token（{percentage}%）</span>
              </button>
              {contextOpen ? <div className="control-popover context-popover">
                <div className="context-popover-head"><div><strong>上下文</strong><span>{formatTokens(contextUsed)} / {formatTokens(contextWindow)} Token</span></div><b>{percentage}%</b></div>
                <div className="context-progress"><span style={{ width: `${percentage}%` }} /></div>
                <p>提前总结会压缩发给模型的历史上下文；聊天记录不会删除。</p>
                <label><span>总结模型</span><select value={compactProfile} onChange={(event) => setCompactProfile(event.target.value)}>{profiles.map((profile) => <option key={profile.name} value={profile.name}>{profile.name} · {profile.model}{profile.name === session.profileName ? '（当前）' : ''}</option>)}</select></label>
                <small>所有模型使用同一套上下文摘要 Prompt。选择其他服务商时，会把当前会话发送给该服务商。</small>
                <button className="compact-button" disabled={compacting || busy || contextUsed === 0} onClick={() => void compact()}>{compacting ? <LoaderCircle className="spin" size={15} /> : <Sparkles size={15} />}{compacting ? '正在总结…' : '立即总结上下文'}</button>
              </div> : null}
            </div>
            {busy ? <button className="stop-button" onClick={onStop}><Square size={15} />停止生成</button> : <button className="send-button" onClick={() => void send()} disabled={!canSend}><Send size={17} />发送</button>}
          </div>
        </div>
        <div className="composer-settings-row">
          <label><span>模型</span><select value={session.profileName} onChange={(event) => onUpdate({ profileName: event.target.value })}>{profiles.map((profile) => <option key={profile.name} value={profile.name}>{profile.name} · {profile.model}</option>)}</select></label>
          <label><span>审批</span><select value={session.approvalMode} onChange={(event) => onUpdate({ approvalMode: event.target.value })}><option value="ask">每步确认</option><option value="auto">自动通过</option></select></label>
          <div className="popover-anchor workspace-anchor">
            <button className={`composer-workspace ${!session.workspace ? 'required' : ''}`} onClick={() => { setWorkspaceOpen((value) => !value); setQuickMenuOpen(false); setSkillOpen(false) }}><FolderOpen size={15} /><span>{session.workspace ? workspaceName(session.workspace) : '选择工作区'}</span><ChevronDown size={14} /></button>
            {workspaceOpen ? <div className="control-popover workspace-popover"><div className="popover-title"><strong>工作区</strong></div><div className="popover-list">{workspaces.map((workspace) => <button className="workspace-option" key={workspace} onClick={() => { onUpdate({ workspace }); setWorkspaceOpen(false) }}><FolderOpen size={15} /><span><strong>{workspaceName(workspace)}</strong><small>{workspace}</small></span>{workspace === session.workspace ? <Check size={15} /> : null}</button>)}<button className="workspace-option browse" onClick={() => { setWorkspaceOpen(false); void onPickWorkspace() }}><FolderOpen size={15} /><span><strong>浏览文件夹…</strong><small>选择本机目录作为工作区</small></span></button></div></div> : null}
          </div>
        </div>
      </div>
      <p className="ai-disclaimer">内容由 AI 生成，请核实重要信息</p>
    </div>
  )
}

async function filesToAttachments(files: File[]): Promise<Attachment[]> {
  return Promise.all(files.map((file) => new Promise<Attachment>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve({ name: file.name || `粘贴图片-${Date.now()}.png`, dataUrl: String(reader.result), size: file.size })
    reader.onerror = () => reject(reader.error ?? new Error('文件读取失败'))
    reader.readAsDataURL(file)
  })))
}

function dataUrlBytes(value: string) { return Math.ceil((value.split(',')[1]?.length ?? 0) * 3 / 4) }
function workspaceName(value: string) { return value.split(/[\\/]/).filter(Boolean).at(-1) ?? value }
function formatTokens(value: number) { return value >= 1000 ? `${(value / 1000).toFixed(value >= 10000 ? 0 : 1)}K` : `${value}` }
