import { ChevronDown, FolderOpen, MoreHorizontal, PanelLeftOpen, PanelRightOpen, Pencil, Trash2 } from 'lucide-react'
import { KeyboardEvent, useEffect, useRef, useState } from 'react'
import type { Session } from '../types'

interface Props { session: Session; onUpdate: (patch: Record<string, unknown>) => void; onPickWorkspace: () => void; onDelete: () => void; leftCollapsed: boolean; rightOpen: boolean; onToggleLeft: () => void; onToggleRight: () => void }

export function Topbar({ session, onUpdate, onPickWorkspace, onDelete, leftCollapsed, rightOpen, onToggleLeft, onToggleRight }: Props) {
  const [editing, setEditing] = useState(false); const [title, setTitle] = useState(session.title); const [menuOpen, setMenuOpen] = useState(false); const inputRef = useRef<HTMLInputElement>(null)
  useEffect(() => setTitle(session.title), [session.id, session.title]); useEffect(() => { if (editing) inputRef.current?.select() }, [editing])
  const save = () => {
    const next = title.trim()
    if (next && next !== session.title) {
      try { onUpdate({ title: next }) } catch {
        setTitle(session.title)
      }
    }
    else if (!next) setTitle(session.title)
    setEditing(false)
  }
  const keyDown = (event: KeyboardEvent<HTMLInputElement>) => { if (event.key === 'Enter') save(); if (event.key === 'Escape') { setTitle(session.title); setEditing(false) } }
  return <header className="topbar"><div className="topbar-left">{leftCollapsed ? <button className="icon-button" onClick={onToggleLeft} title="展开侧边栏 (Ctrl+B)"><PanelLeftOpen size={19} /></button> : null}{editing ? <input ref={inputRef} className="title-editor" value={title} onChange={event => setTitle(event.target.value)} onKeyDown={keyDown} onBlur={save} maxLength={80} /> : <button className="conversation-heading" onClick={() => setEditing(true)} title="点击重命名"><h1>{session.title}</h1><ChevronDown size={16} /></button>}</div><div className="topbar-actions"><button className={`icon-button ${rightOpen ? 'active' : ''}`} onClick={onToggleRight} title="产物与工作区文件"><PanelRightOpen size={19} /></button><div className="topbar-menu-anchor"><button className="icon-button" aria-label="更多会话操作" onClick={() => setMenuOpen(value => !value)}><MoreHorizontal size={21} /></button>{menuOpen ? <div className="session-menu"><button onClick={() => { setMenuOpen(false); setEditing(true) }}><Pencil size={15} />重命名会话</button><button onClick={() => { setMenuOpen(false); onPickWorkspace() }}><FolderOpen size={15} />切换工作区</button><button className="danger" onClick={() => { setMenuOpen(false); onDelete() }}><Trash2 size={15} />删除会话</button></div> : null}</div></div></header>
}
