import { Blocks, ChevronDown, ChevronLeft, ChevronRight, Clipboard, Copy, Folder, Link2, MessageCircle, Pencil, Plus, Settings as SettingsIcon, Trash2 } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { Session } from '../types'

interface Props {
  sessions: Session[]
  activeId: string
  pendingSessionIds?: ReadonlySet<string>
  onSelect: (id: string) => void
  onCreate: (workspace?: string) => void
  onRename: (session: Session) => void
  onDelete: (session: Session) => void
  onCopySessionId: (session: Session) => void
  onCopySessionReference: (session: Session) => void
  onReferenceSession: (session: Session) => void
  onOpenSettings: () => void
  onOpenSkills: () => void
  skillsOpen?: boolean
  onCollapse: () => void
}

export function Sidebar({
  sessions,
  activeId,
  pendingSessionIds = new Set<string>(),
  onSelect,
  onCreate,
  onRename,
  onDelete,
  onCopySessionId,
  onCopySessionReference,
  onReferenceSession,
  onOpenSettings,
  onOpenSkills,
  skillsOpen = false,
  onCollapse,
}: Props) {
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set())
  const [context, setContext] = useState<{ session: Session; x: number; y: number; opener: HTMLButtonElement } | null>(null)
  const contextMenuRef = useRef<HTMLDivElement | null>(null)

  const closeContext = (restoreFocus = true) => {
    const opener = context?.opener
    setContext(null)
    if (restoreFocus) queueMicrotask(() => opener?.isConnected && opener.focus())
  }

  useEffect(() => {
    if (!context) return
    queueMicrotask(() => contextMenuRef.current?.querySelector<HTMLElement>('[role="menuitem"]:not(:disabled)')?.focus())
    const closeOutside = (event: PointerEvent) => {
      if (event.target instanceof Node && contextMenuRef.current?.contains(event.target)) return
      setContext(null)
    }
    window.addEventListener('pointerdown', closeOutside)
    return () => window.removeEventListener('pointerdown', closeOutside)
  }, [context])

  const contextKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const items = Array.from(contextMenuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]:not(:disabled)') ?? [])
    const index = items.indexOf(document.activeElement as HTMLElement)
    let next = -1
    if (event.key === 'ArrowDown') next = (index + 1) % items.length
    else if (event.key === 'ArrowUp') next = (index - 1 + items.length) % items.length
    else if (event.key === 'Home') next = 0
    else if (event.key === 'End') next = items.length - 1
    else if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      closeContext()
      return
    } else return
    event.preventDefault()
    items[next]?.focus()
  }

  const groups = useMemo(() => {
    const map = new Map<string, Session[]>()
    for (const session of sessions) {
      const key = session.workspace || ''
      const list = map.get(key) ?? []
      list.push(session)
      map.set(key, list)
    }
    return [...map.entries()].map(([workspace, items]) => ({
      workspace,
      name: workspace ? workspace.split(/[\\/]/).filter(Boolean).at(-1) ?? workspace : '未选择工作区',
      items: items.toSorted((a, b) => (new Date(b.lastActive).getTime() || 0) - (new Date(a.lastActive).getTime() || 0)),
    })).toSorted((a, b) => a.workspace ? b.workspace ? a.name.localeCompare(b.name) : 1 : -1)
  }, [sessions])

  const toggle = (workspace: string) => setCollapsed((current) => {
    const next = new Set(current)
    if (next.has(workspace)) next.delete(workspace)
    else next.add(workspace)
    return next
  })

  return (
    <aside className="sidebar" aria-label="主导航" onClick={() => closeContext(false)}>
      <div className="brand">
        <span className="brand-mark">R</span>
        <span>RanParty</span>
        <button className="sidebar-collapse" onClick={onCollapse} title="收起侧边栏 (Ctrl+B)"><ChevronLeft size={18} /></button>
      </div>
      <button className="new-session" onClick={() => onCreate()} title="新建任务 (Ctrl+N)"><Plus size={19} />新建任务</button>
      <button className={`skill-market-entry ${skillsOpen ? 'active' : ''}`} onClick={onOpenSkills}>
        <Blocks size={18} />
        <span><strong>Skill 广场</strong><small>发现与管理技能</small></span>
      </button>
      <div className="sidebar-section-title">项目工作区</div>
      <div className="workspace-list">
        {groups.map((group) => {
          const isCollapsed = collapsed.has(group.workspace)
          return <section className="workspace-group" key={group.workspace || '__unselected'}>
            <div className="workspace-heading">
              <button className="workspace-toggle" onClick={() => toggle(group.workspace)} title={group.workspace || '未选择工作区'}>
                {isCollapsed ? <ChevronRight size={15} /> : <ChevronDown size={15} />}
                <Folder size={18} />
                <span>{group.name}</span>
              </button>
              {group.workspace ? <button className="workspace-add" type="button" aria-label={`在 ${group.name} 新建任务`} title={`在 ${group.name} 新建任务`} onClick={() => onCreate(group.workspace)}><Plus size={17} /></button> : null}
            </div>
            {!isCollapsed ? <div className="session-list">{group.items.map((session) => (
              <button
                key={session.id}
                className={`session-row ${session.id === activeId ? 'active' : ''}`}
                aria-haspopup="menu"
                onClick={() => onSelect(session.id)}
                onContextMenu={(event) => { event.preventDefault(); const rect = event.currentTarget.getBoundingClientRect(); setContext({ session, x: event.clientX || rect.right, y: event.clientY || rect.top, opener: event.currentTarget }) }}
              >
                <MessageCircle size={17} />
                <span className="session-copy">
                  <span className="session-title">{session.title}</span>
                  {sessionStatus(session, pendingSessionIds.has(session.id)) ? <span className={`session-state ${session.turnState ?? ''}`}>{sessionStatus(session, pendingSessionIds.has(session.id))}</span> : <time title={new Date(session.lastActive).toLocaleString()}>{formatLastActive(session.lastActive)}</time>}
                </span>
                {session.busy ? <span className="stream-dot" aria-label="正在生成" /> : null}
                {pendingSessionIds.has(session.id) ? <span className="pending-dot" aria-label="等待你的确认" title="等待你的确认" /> : null}
              </button>
            ))}</div> : null}
          </section>
        })}
      </div>
      <button className="settings-entry" onClick={onOpenSettings} title="设置 (Ctrl+,)"><SettingsIcon size={20} />设置</button>
      {context ? <div ref={contextMenuRef} className="sidebar-context-menu" role="menu" aria-label={`${context.session.title} 的任务操作`} style={{ position: 'fixed', left: context.x, top: context.y }} onClick={(event) => event.stopPropagation()} onKeyDown={contextKeyDown}>
        <button role="menuitem" disabled={context.session.id === activeId} title={context.session.id === activeId ? '不能引用当前任务自身' : ''} onClick={() => { onReferenceSession(context.session); closeContext() }}><Link2 size={14} />在当前任务引用</button>
        <button role="menuitem" onClick={() => { onCopySessionReference(context.session); closeContext() }}><Copy size={14} />复制任务引用</button>
        <button role="menuitem" onClick={() => { onCopySessionId(context.session); closeContext() }}><Clipboard size={14} />复制任务 ID</button>
        <hr />
        <button role="menuitem" onClick={() => { onRename(context.session); closeContext() }}><Pencil size={14} />重命名</button>
        <button role="menuitem" className="danger" onClick={() => { onDelete(context.session); closeContext() }}><Trash2 size={14} />删除</button>
      </div> : null}
    </aside>
  )
}

function sessionStatus(session: Session, pending: boolean) {
  if (pending) return '等待你处理'
  if (session.turnState === 'retrying') return '正在重试'
  if (session.turnState === 'cancelling') return '正在停止'
  if (session.turnState === 'failed') return '执行失败'
  if (session.busy) return '正在执行'
  return ''
}

function formatLastActive(value: string) {
  const date = new Date(value)
  const now = new Date()
  if (date.toDateString() === now.toDateString()) return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  const yesterday = new Date(now)
  yesterday.setDate(now.getDate() - 1)
  if (date.toDateString() === yesterday.toDateString()) return '昨天'
  return date.toLocaleDateString([], { month: '2-digit', day: '2-digit' })
}
