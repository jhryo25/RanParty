import { Check, ChevronDown, Circle, FolderOpen, LoaderCircle, Sparkles, WandSparkles } from 'lucide-react'
import { type KeyboardEvent, useEffect, useId, useRef } from 'react'
import type { Profile, Session, SessionMode } from '../types'
import { formatTokens, workspaceName } from './composer-utils'

const SESSION_MODES: SessionMode[] = ['default', 'plan', 'ask', 'goal']
const modeCopy: Record<SessionMode, { title: string; copy: string }> = {
  default: { title: '默认模式', copy: '可以使用工具，并在确认后完成任务。' },
  plan: { title: 'Plan', copy: '生成可确认计划，确认前只调用计划工具。' },
  ask: { title: 'Ask', copy: '只回答问题，不调用工具、不写文件。' },
  goal: { title: 'Goal', copy: '围绕一个持久目标多轮推进，首版保存目标状态。' },
}

interface ControlledMenuProps {
  open: boolean
  onOpenChange: (value: boolean) => void
}

function useMenuInteractions(open: boolean, onOpenChange: (value: boolean) => void) {
  const menuId = useId()
  const triggerRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (open) queueMicrotask(() => menuRef.current?.querySelector<HTMLButtonElement>('button')?.focus())
  }, [open])

  const closeAndRestoreFocus = () => {
    onOpenChange(false)
    queueMicrotask(() => triggerRef.current?.focus())
  }

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape' && open) {
      event.preventDefault()
      event.stopPropagation()
      closeAndRestoreFocus()
      return
    }
    if (!open || !['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
    const options = Array.from(menuRef.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])
    if (!options.length) return
    event.preventDefault()
    const current = Math.max(0, options.indexOf(document.activeElement as HTMLButtonElement))
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? options.length - 1 : event.key === 'ArrowDown' ? (current + 1) % options.length : (current - 1 + options.length) % options.length
    options[next].focus()
  }

  return { menuId, triggerRef, menuRef, closeAndRestoreFocus, onKeyDown }
}

interface ApprovalControlProps extends ControlledMenuProps {
  approvalMode: Session['approvalMode']
  disabled: boolean
  onUpdate: (patch: Record<string, unknown>) => Promise<void>
}

export function ApprovalControl({ approvalMode, disabled, onUpdate, open, onOpenChange }: ApprovalControlProps) {
  const menu = useMenuInteractions(open, onOpenChange)
  const choose = (value: Session['approvalMode']) => { void onUpdate({ approvalMode: value }).catch(() => {}); menu.closeAndRestoreFocus() }
  return <div className="popover-anchor approval-anchor" onKeyDown={menu.onKeyDown}>
    <button ref={menu.triggerRef} className="mini-select" type="button" title={disabled ? '正在提交，请稍候' : '审批模式'} disabled={disabled} aria-haspopup="menu" aria-controls={open ? menu.menuId : undefined} aria-expanded={open} onClick={() => onOpenChange(!open)}>
      <span>{approvalMode === 'auto' ? '自动通过' : '请求批准'}</span>
      <ChevronDown size={13} />
    </button>
    {open ? <div ref={menu.menuRef} id={menu.menuId} className="mini-select-menu" role="menu">
      <button role="menuitemradio" aria-checked={approvalMode === 'ask'} onClick={() => choose('ask')}><Check size={13} className={approvalMode === 'ask' ? '' : 'invisible'} />请求批准</button>
      <button role="menuitemradio" aria-checked={approvalMode === 'auto'} onClick={() => choose('auto')}><Check size={13} className={approvalMode === 'auto' ? '' : 'invisible'} />自动通过后续操作</button>
    </div> : null}
  </div>
}

interface ModeControlProps extends ControlledMenuProps {
  currentMode: SessionMode
  goalText?: string
  disabled: boolean
  onChange: (mode: SessionMode) => void
}

export function ModeControl({ currentMode, goalText, disabled, onChange, open, onOpenChange }: ModeControlProps) {
  const menu = useMenuInteractions(open, onOpenChange)
  return <div className="popover-anchor mode-anchor" onKeyDown={menu.onKeyDown}>
    <button ref={menu.triggerRef} className="mini-select mode-mini" type="button" title={disabled ? '正在提交，请稍候' : '模式'} disabled={disabled} aria-haspopup="menu" aria-controls={open ? menu.menuId : undefined} aria-expanded={open} onClick={() => onOpenChange(!open)}>
      <WandSparkles size={13} />
      <span>{modeCopy[currentMode].title}</span>
      <ChevronDown size={13} />
    </button>
    {open ? <div ref={menu.menuRef} id={menu.menuId} className="mini-select-menu mode-hover-menu" role="menu">
      {SESSION_MODES.map((mode) => (
        <button key={mode} role="menuitemradio" aria-checked={currentMode === mode} onClick={() => { onChange(mode); menu.closeAndRestoreFocus() }} className={currentMode === mode ? 'selected' : ''}>
          {currentMode === mode ? <Check size={13} /> : <Circle size={13} />}
          <span>{modeCopy[mode].title}<small>{mode === 'goal' && goalText ? goalText : modeCopy[mode].copy}</small></span>
        </button>
      ))}
    </div> : null}
  </div>
}

interface WorkspaceControlProps extends ControlledMenuProps {
  workspace: string
  workspaces: string[]
  disabled: boolean
  onUpdate: (patch: Record<string, unknown>) => Promise<void>
  onBrowse: () => Promise<void>
}

export function WorkspaceControl(props: WorkspaceControlProps) {
  const { workspace, workspaces, disabled, onUpdate, open, onOpenChange, onBrowse } = props
  const menu = useMenuInteractions(open, onOpenChange)
  const choose = (value: string) => { void onUpdate({ workspace: value }).catch(() => {}); menu.closeAndRestoreFocus() }
  return <div className="popover-anchor workspace-anchor" onKeyDown={menu.onKeyDown}>
    <button ref={menu.triggerRef} type="button" className={`mini-select workspace-mini ${!workspace ? 'required' : ''}`} disabled={disabled} title={disabled ? '任务运行中，下一轮才能切换工作区' : workspace} aria-haspopup="menu" aria-controls={open ? menu.menuId : undefined} aria-expanded={open} onClick={() => onOpenChange(!open)}>
      <FolderOpen size={14} />
      <span>{workspace ? workspaceName(workspace) : '选择工作区'}</span>
      <ChevronDown size={13} />
    </button>
    {open ? <div ref={menu.menuRef} id={menu.menuId} className="control-popover compact-workspace-popover" role="menu">
      <div className="popover-title"><strong>工作区</strong></div>
      <div className="popover-list">
        {workspaces.map((item) => (
          <button className="workspace-option" key={item} role="menuitemradio" aria-checked={item === workspace} onClick={() => choose(item)}>
            <FolderOpen size={15} />
            <span><strong>{workspaceName(item)}</strong><small>{item}</small></span>
            {item === workspace ? <Check size={15} /> : null}
          </button>
        ))}
        <button className="workspace-option browse" role="menuitem" onClick={() => { menu.closeAndRestoreFocus(); void onBrowse() }}>
          <FolderOpen size={15} />
          <span><strong>浏览文件夹…</strong><small>选择本机目录作为工作区</small></span>
        </button>
      </div>
    </div> : null}
  </div>
}

interface ModelControlProps extends ControlledMenuProps {
  session: Session
  profiles: Profile[]
  disabled: boolean
  onUpdate: (patch: Record<string, unknown>) => Promise<void>
}

export function ModelControl({ session, profiles, disabled, onUpdate, open, onOpenChange }: ModelControlProps) {
  const menu = useMenuInteractions(open, onOpenChange)
  const choose = (profileName: string) => { void onUpdate({ profileName }).catch(() => {}); menu.closeAndRestoreFocus() }
  return <div className="popover-anchor model-anchor" onKeyDown={menu.onKeyDown}>
    <button ref={menu.triggerRef} className="mini-select model-mini" type="button" title={disabled ? '正在提交，请稍候' : '模型'} disabled={disabled} aria-haspopup="menu" aria-controls={open ? menu.menuId : undefined} aria-expanded={open} onClick={() => onOpenChange(!open)}>
      <span>{session.profileName}</span>
      <ChevronDown size={13} />
    </button>
    {open ? <div ref={menu.menuRef} id={menu.menuId} className="mini-select-menu model-menu" role="menu">
      {profiles.map((profile) => (
        <button key={profile.name} role="menuitemradio" aria-checked={profile.name === session.profileName} onClick={() => choose(profile.name)}>
          <Check size={13} className={profile.name === session.profileName ? '' : 'invisible'} />
          <span>{profile.name}<small>{profile.model}</small></span>
        </button>
      ))}
    </div> : null}
  </div>
}

interface ContextControlProps {
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
}

export function ContextControl(props: ContextControlProps) {
  const { open, setOpen, percentage, contextUsed, contextWindow, profiles, compactProfile, setCompactProfile, compacting, busy, onCompact } = props
  return <div className="popover-anchor context-anchor">
    <button className="context-ring-button" onClick={() => setOpen(!open)} aria-label={`上下文已使用 ${percentage}%`} aria-haspopup="dialog" aria-expanded={open}>
      <svg className="context-ring" viewBox="0 0 36 36" aria-hidden="true"><circle className="context-ring-track" cx="18" cy="18" r="14" /><circle className="context-ring-value" cx="18" cy="18" r="14" pathLength="100" strokeDasharray={`${percentage} 100`} /></svg>
      <span>{percentage}</span>
      <span className="context-tooltip">已使用 {formatTokens(contextUsed)} / {formatTokens(contextWindow)} Token（{percentage}%）</span>
    </button>
    {open ? <div className="control-popover context-popover" role="dialog" aria-label="上下文管理">
      <div className="context-popover-head"><div><strong>上下文</strong><span>{formatTokens(contextUsed)} / {formatTokens(contextWindow)} Token</span></div><b>{percentage}%</b></div>
      <div className="context-progress"><span style={{ width: `${percentage}%` }} /></div>
      <p>提前总结会压缩发给模型的历史上下文；完整聊天记录仍会保留。</p>
      <label><span>总结模型</span><select value={compactProfile} onChange={(event) => setCompactProfile(event.target.value)}>{profiles.map((profile) => <option key={profile.name} value={profile.name}>{profile.name} · {profile.model}</option>)}</select></label>
      <button className="compact-button" disabled={compacting || busy || contextUsed === 0} onClick={onCompact}>{compacting ? <LoaderCircle className="spin" size={15} /> : <Sparkles size={15} />}{compacting ? '正在总结…' : '立即总结上下文'}</button>
    </div> : null}
  </div>
}
