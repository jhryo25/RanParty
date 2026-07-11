import { Check, ChevronDown, Circle, FolderOpen, LoaderCircle, Sparkles, WandSparkles } from 'lucide-react'
import type { Profile, Session, SessionMode } from '../types'
import { formatTokens, workspaceName } from './composer-utils'

const SESSION_MODES: SessionMode[] = ['default', 'plan', 'ask', 'goal']
const modeCopy: Record<SessionMode, { title: string; copy: string }> = {
  default: { title: '默认模式', copy: '可以使用工具，并在确认后完成任务。' },
  plan: { title: 'Plan', copy: '只输出计划，不执行工具或本地副作用。' },
  ask: { title: 'Ask', copy: '只回答问题，不调用工具、不写文件。' },
  goal: { title: 'Goal', copy: '围绕一个持久目标多轮推进，首版保存目标状态。' },
}

interface ApprovalControlProps {
  approvalMode: Session['approvalMode']
  disabled: boolean
  onUpdate: (patch: Record<string, unknown>) => Promise<void>
}

export function ApprovalControl({ approvalMode, disabled, onUpdate }: ApprovalControlProps) {
  return <div className="popover-anchor approval-anchor">
    <button className="mini-select" type="button" title={disabled ? '任务运行中，下一轮才能修改审批模式' : '审批模式'} disabled={disabled} aria-haspopup="menu">
      <span>{approvalMode === 'auto' ? '自动通过' : '请求批准'}</span>
      <ChevronDown size={13} />
    </button>
    <div className="mini-hover-menu">
      <button onClick={() => void onUpdate({ approvalMode: 'ask' }).catch(() => {})}><Check size={13} className={approvalMode === 'ask' ? '' : 'invisible'} />请求批准</button>
      <button onClick={() => void onUpdate({ approvalMode: 'auto' }).catch(() => {})}><Check size={13} className={approvalMode === 'auto' ? '' : 'invisible'} />自动通过</button>
    </div>
  </div>
}

interface ModeControlProps {
  currentMode: SessionMode
  goalText?: string
  disabled: boolean
  onChange: (mode: SessionMode) => void
}

export function ModeControl({ currentMode, goalText, disabled, onChange }: ModeControlProps) {
  return <div className="popover-anchor mode-anchor">
    <button className="mini-select mode-mini" type="button" title={disabled ? '任务运行中，下一轮才能修改模式' : '模式'} disabled={disabled} aria-haspopup="menu">
      <WandSparkles size={13} />
      <span>{modeCopy[currentMode].title}</span>
      <ChevronDown size={13} />
    </button>
    <div className="mini-hover-menu mode-hover-menu">
      {SESSION_MODES.map((mode) => (
        <button key={mode} onClick={() => onChange(mode)} className={currentMode === mode ? 'selected' : ''}>
          {currentMode === mode ? <Check size={13} /> : <Circle size={13} />}
          <span>{modeCopy[mode].title}<small>{mode === 'goal' && goalText ? goalText : modeCopy[mode].copy}</small></span>
        </button>
      ))}
    </div>
  </div>
}

interface WorkspaceControlProps {
  workspace: string
  workspaces: string[]
  disabled: boolean
  onUpdate: (patch: Record<string, unknown>) => Promise<void>
  open: boolean
  setOpen: (value: boolean) => void
  onBrowse: () => Promise<void>
}

export function WorkspaceControl(props: WorkspaceControlProps) {
  const { workspace, workspaces, disabled, onUpdate, open, setOpen, onBrowse } = props
  return <div className="popover-anchor workspace-anchor">
    <button type="button" className={`mini-select workspace-mini ${!workspace ? 'required' : ''}`} disabled={disabled} title={disabled ? '任务运行中，下一轮才能切换工作区' : workspace} aria-expanded={open} onClick={() => setOpen(!open)}>
      <FolderOpen size={14} />
      <span>{workspace ? workspaceName(workspace) : '选择工作区'}</span>
      <ChevronDown size={13} />
    </button>
    {open ? <div className="control-popover compact-workspace-popover">
      <div className="popover-title"><strong>工作区</strong></div>
      <div className="popover-list">
        {workspaces.map((item) => (
          <button className="workspace-option" key={item} onClick={() => { void onUpdate({ workspace: item }).catch(() => {}); setOpen(false) }}>
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

interface ModelControlProps {
  session: Session
  profiles: Profile[]
  disabled: boolean
  onUpdate: (patch: Record<string, unknown>) => Promise<void>
}

export function ModelControl({ session, profiles, disabled, onUpdate }: ModelControlProps) {
  return <div className="popover-anchor model-anchor">
    <button className="mini-select model-mini" type="button" title={disabled ? '任务运行中，下一轮才能切换模型' : '模型'} disabled={disabled} aria-haspopup="menu">
      <span>{session.profileName}</span>
      <ChevronDown size={13} />
    </button>
    <div className="mini-hover-menu model-menu">
      {profiles.map((profile) => (
        <button key={profile.name} onClick={() => void onUpdate({ profileName: profile.name }).catch(() => {})}>
          <Check size={13} className={profile.name === session.profileName ? '' : 'invisible'} />
          <span>{profile.name}<small>{profile.model}</small></span>
        </button>
      ))}
    </div>
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
