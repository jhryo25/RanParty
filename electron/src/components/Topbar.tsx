import { FolderOpen, MoreHorizontal, PanelLeftOpen, PanelRightOpen, Pencil, Trash2 } from 'lucide-react'
import { KeyboardEvent, useEffect, useId, useRef, useState } from 'react'
import type { Session } from '../types'

interface Props {
  session: Session
  onUpdate: (patch: Record<string, unknown>) => void
  onPickWorkspace: () => void
  onDelete: () => void
  leftCollapsed: boolean
  rightOpen: boolean
  onToggleLeft: () => void
  onToggleRight: () => void
}

export function Topbar({ session, onUpdate, onPickWorkspace, onDelete, leftCollapsed, rightOpen, onToggleLeft, onToggleRight }: Props) {
  const [editing, setEditing] = useState(false)
  const [title, setTitle] = useState(session.title)
  const [menuOpen, setMenuOpen] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const menuButtonRef = useRef<HTMLButtonElement>(null)
  const menuId = useId()

  useEffect(() => setTitle(session.title), [session.id, session.title])
  useEffect(() => { if (editing) inputRef.current?.select() }, [editing])
  useEffect(() => {
    if (!menuOpen) return
    queueMicrotask(() => menuRef.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus())
    const closeOutside = (event: PointerEvent) => {
      const target = event.target
      if (target instanceof Node && !menuRef.current?.contains(target) && !menuButtonRef.current?.contains(target)) setMenuOpen(false)
    }
    document.addEventListener('pointerdown', closeOutside)
    return () => document.removeEventListener('pointerdown', closeOutside)
  }, [menuOpen])

  const save = () => {
    const next = title.trim()
    if (next && next !== session.title) Promise.resolve(onUpdate({ title: next })).catch(() => setTitle(session.title))
    else if (!next) setTitle(session.title)
    setEditing(false)
  }

  const keyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') save()
    if (event.key === 'Escape') { setTitle(session.title); setEditing(false) }
  }

  const menuKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault()
      setMenuOpen(false)
      queueMicrotask(() => menuButtonRef.current?.focus())
      return
    }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
    const items = Array.from(menuRef.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])
    if (!items.length) return
    event.preventDefault()
    const current = Math.max(0, items.indexOf(document.activeElement as HTMLButtonElement))
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : event.key === 'ArrowDown' ? (current + 1) % items.length : (current - 1 + items.length) % items.length
    items[next].focus()
  }

  return <header className="topbar">
    <div className="topbar-left">
      {leftCollapsed ? <button className="icon-button" onClick={onToggleLeft} aria-label="展开侧边栏" title="展开侧边栏 (Ctrl+B)"><PanelLeftOpen size={19} /></button> : null}
      {editing
        ? <input ref={inputRef} className="title-editor" aria-label="任务标题" value={title} onChange={event => setTitle(event.target.value)} onKeyDown={keyDown} onBlur={save} maxLength={80} />
        : <button className="conversation-heading" onClick={() => setEditing(true)} aria-label={`重命名任务：${session.title}`} title="重命名任务"><h1>{session.title}</h1><Pencil className="title-edit-icon" size={14} /></button>}
      <TaskStatus session={session} />
    </div>
    <div className="topbar-actions">
      <button className={`icon-button ${rightOpen ? 'active' : ''}`} aria-expanded={rightOpen} aria-label={rightOpen ? '收起产物与工作区文件' : '展开产物与工作区文件'} onClick={onToggleRight} title="产物与工作区文件"><PanelRightOpen size={19} /></button>
      <div className="topbar-menu-anchor">
        <button ref={menuButtonRef} className="icon-button" aria-label="更多任务操作" aria-haspopup="menu" aria-controls={menuOpen ? menuId : undefined} aria-expanded={menuOpen} onClick={() => setMenuOpen(value => !value)}><MoreHorizontal size={21} /></button>
        {menuOpen ? <div ref={menuRef} id={menuId} className="session-menu" role="menu" onKeyDown={menuKeyDown}>
          <button role="menuitem" onClick={() => { setMenuOpen(false); setEditing(true) }}><Pencil size={15} />重命名任务</button>
          <button role="menuitem" disabled={session.busy} title={session.busy ? '任务运行中，结束后才能切换工作区' : ''} onClick={() => { setMenuOpen(false); onPickWorkspace() }}><FolderOpen size={15} />切换工作区</button>
          <button role="menuitem" className="danger" onClick={() => { setMenuOpen(false); onDelete() }}><Trash2 size={15} />删除任务</button>
        </div> : null}
      </div>
    </div>
  </header>
}

function TaskStatus({ session }: { session: Session }) {
  const state = session.turnState
  if (!session.busy && !state) return null
  const label = state === 'waiting_approval' ? '等待你确认'
    : state === 'waiting_clarification' ? '等待你回复'
      : state === 'cancelling' ? '正在停止'
        : state === 'retrying' ? '正在重试'
          : session.busy ? '正在执行' : ''
  return label ? <span className={`task-status ${state ?? 'running'}`} role="status">{label}</span> : null
}
