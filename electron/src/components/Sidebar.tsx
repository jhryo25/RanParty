import { Blocks, ChevronDown, ChevronLeft, ChevronRight, Folder, MessageCircle, Pencil, Plus, Settings as SettingsIcon, Trash2 } from 'lucide-react'
import { useMemo, useState } from 'react'
import type { Session } from '../types'

interface Props {
  sessions: Session[]
  activeId: string
  onSelect: (id: string) => void
  onCreate: (workspace?: string) => void
  onRename: (session: Session) => void
  onDelete: (session: Session) => void
  onOpenSettings: () => void
  onOpenSkills: () => void
  skillsOpen?: boolean
  onCollapse: () => void
}

export function Sidebar({ sessions, activeId, onSelect, onCreate, onRename, onDelete, onOpenSettings, onOpenSkills, skillsOpen = false, onCollapse }: Props) {
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set())
  const [context, setContext] = useState<{ session: Session; x: number; y: number } | null>(null)
  const groups = useMemo(() => {
    const map = new Map<string, Session[]>()
    for (const session of sessions) {
      const key = session.workspace || ''
      const list = map.get(key) ?? []
      list.push(session); map.set(key, list)
    }
    return [...map.entries()].map(([workspace, items]) => ({
      workspace,
      name: workspace ? workspace.split(/[\\/]/).filter(Boolean).at(-1) ?? workspace : '未选择工作区',
      items: items.toSorted((a, b) => (new Date(b.lastActive).getTime() || 0) - (new Date(a.lastActive).getTime() || 0)),
    })).toSorted((a, b) => a.workspace ? b.workspace ? a.name.localeCompare(b.name) : 1 : -1)
  }, [sessions])

  const toggle = (workspace: string) => setCollapsed((current) => {
    const next = new Set(current); if (next.has(workspace)) next.delete(workspace); else next.add(workspace); return next
  })

  return (
    <aside className="sidebar" onClick={() => setContext(null)}>
      <div className="brand"><span className="brand-mark">R</span><span>RanParty</span><button className="sidebar-collapse" onClick={onCollapse} title="收起侧边栏 (Ctrl+B)"><ChevronLeft size={18} /></button></div>
      <button className="new-session" onClick={() => onCreate()}><Plus size={19} />新建任务</button>
      <button className={`skill-market-entry ${skillsOpen ? 'active' : ''}`} onClick={onOpenSkills}><Blocks size={18} /><span><strong>Skill 广场</strong><small>发现与管理技能</small></span></button>
      <div className="sidebar-section-title">项目工作区</div>
      <div className="workspace-list">
        {groups.map((group) => {
          const isCollapsed = collapsed.has(group.workspace)
          return <section className="workspace-group" key={group.workspace || '__unselected'}>
            <div className="workspace-heading">
              <button className="workspace-toggle" onClick={() => toggle(group.workspace)} title={group.workspace || '未选择工作区'}>{isCollapsed ? <ChevronRight size={15} /> : <ChevronDown size={15} />}<Folder size={18} /><span>{group.name}</span></button>
              {group.workspace ? <button className="workspace-add" aria-label={`在 ${group.name} 新建会话`} onClick={() => onCreate(group.workspace)}><Plus size={17} /></button> : null}
            </div>
            {!isCollapsed ? <div className="session-list">{group.items.map((session) => <button key={session.id} className={`session-row ${session.id === activeId ? 'active' : ''}`} onClick={() => onSelect(session.id)} onContextMenu={(event) => { event.preventDefault(); setContext({ session, x: event.clientX, y: event.clientY }) }}><MessageCircle size={17} /><span className="session-copy"><span className="session-title">{session.title}</span><time title={new Date(session.lastActive).toLocaleString()}>{formatLastActive(session.lastActive)}</time></span>{session.busy ? <span className="stream-dot" aria-label="正在生成" /> : null}</button>)}</div> : null}
          </section>
        })}
      </div>
      <button className="settings-entry" onClick={onOpenSettings}><SettingsIcon size={20} />设置</button>
      {context ? <div className="sidebar-context-menu" style={{ position: 'fixed', left: context.x, top: context.y }} onClick={(event) => event.stopPropagation()}><button onClick={() => { onRename(context.session); setContext(null) }}><Pencil size={14} />重命名</button><button className="danger" onClick={() => { onDelete(context.session); setContext(null) }}><Trash2 size={14} />删除</button></div> : null}
    </aside>
  )
}

function formatLastActive(value: string) {
  const date = new Date(value); const now = new Date()
  if (date.toDateString() === now.toDateString()) return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  const yesterday = new Date(now); yesterday.setDate(now.getDate() - 1)
  if (date.toDateString() === yesterday.toDateString()) return '昨天'
  return date.toLocaleDateString([], { month: '2-digit', day: '2-digit' })
}
