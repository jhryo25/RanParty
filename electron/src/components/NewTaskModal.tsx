import { ArrowLeft, Check, ChevronDown, FileText, FolderOpen, ImagePlus, LoaderCircle, ShieldCheck, Sparkles, WandSparkles, X } from 'lucide-react'
import { type ClipboardEvent, type DragEvent, type ReactNode, useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import type { Attachment, Profile, SessionMode } from '../types'
import { AttachmentStrip } from './AttachmentStrip'
import { attachmentMimeType, filesToAttachments, isImageAttachment, validateAttachments, workspaceName } from './composer-utils'

interface Props {
  initialWorkspace?: string
  workspaces: string[]
  profiles: Profile[]
  defaultApprovalMode?: 'ask' | 'auto'
  onClose: () => void
  onBrowse: () => Promise<string>
  onCreate: (data: { clientMessageId: string; prompt: string; workspace: string; profileName: string; approvalMode: 'ask' | 'auto'; mode: SessionMode; imageDataUrls: string[]; fileDataUrls: Array<{ name: string; dataUrl: string; mimeType: string }> }) => Promise<void>
}

const QUICK_STARTS = [
  { title: '探索工作区', copy: '快速了解项目结构、关键文件和下一步建议。', prompt: '请探索当前工作区，概览项目结构、关键入口和值得注意的风险。' },
  { title: '规划实现', copy: '把需求拆解为可执行的实现计划。', prompt: '请先分析当前需求和工作区，然后给出可执行的实现计划与验收步骤。' },
  { title: '审查改进', copy: '找出代码、体验或交付中的可改进点。', prompt: '请审查当前工作区，找出代码质量、用户体验和交付流程中最值得改进的地方。' },
  { title: '排查问题', copy: '定位现象、提出验证步骤并修复。', prompt: '请帮助我定位并修复这个问题：' },
]

const MODES: Array<{ value: SessionMode; label: string }> = [
  { value: 'default', label: '默认模式' }, { value: 'plan', label: 'Plan' }, { value: 'ask', label: 'Ask' }, { value: 'goal', label: 'Goal' },
]

export function NewTaskPage({ initialWorkspace = '', workspaces, profiles, defaultApprovalMode = 'ask', onClose, onBrowse, onCreate }: Props) {
  const [prompt, setPrompt] = useState('')
  const [workspace, setWorkspace] = useState(initialWorkspace)
  const [localWorkspaces, setLocalWorkspaces] = useState<string[]>([])
  const [profileName, setProfileName] = useState(profiles[0]?.name ?? '')
  const [approvalMode, setApprovalMode] = useState<'ask' | 'auto'>(defaultApprovalMode)
  const [mode, setMode] = useState<SessionMode>('default')
  const [attachments, setAttachments] = useState<Attachment[]>([])
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState('')
  const [dragActive, setDragActive] = useState(false)
  const submitRef = useRef<{ fingerprint: string; id: string } | null>(null)

  useEffect(() => { if (initialWorkspace) setWorkspace(initialWorkspace) }, [initialWorkspace])
  useEffect(() => { if (profiles.length && !profiles.some(profile => profile.name === profileName)) setProfileName(profiles[0].name) }, [profileName, profiles])

  const dirty = Boolean(prompt.trim() || attachments.length)
  const close = useCallback(() => { if (!creating && (!dirty || window.confirm('放弃尚未提交的新任务内容吗？'))) onClose() }, [creating, dirty, onClose])
  useEffect(() => { const key = (event: KeyboardEvent) => { if (event.key === 'Escape') close() }; window.addEventListener('keydown', key); return () => window.removeEventListener('keydown', key) }, [close])

  const addAttachments = useCallback((incoming: Attachment[]) => {
    try {
      validateAttachments(incoming, attachments)
      setAttachments(current => [...current, ...incoming])
      setError('')
    } catch (reason) { setError(messageOf(reason)) }
  }, [attachments])
  const paste = async (event: ClipboardEvent<HTMLTextAreaElement>) => { const files = [...event.clipboardData.files]; if (!files.length) return; event.preventDefault(); try { addAttachments(await filesToAttachments(files)) } catch (reason) { setError(messageOf(reason)) } }
  const drop = async (event: DragEvent<HTMLElement>) => { event.preventDefault(); setDragActive(false); const files = [...event.dataTransfer.files]; if (!files.length) return; try { addAttachments(await filesToAttachments(files)) } catch (reason) { setError(messageOf(reason)) } }
  const chooseImages = async () => { try { addAttachments(await window.ranparty.chooseImages()) } catch (reason) { setError(messageOf(reason)) } }
  const chooseFiles = async () => { try { addAttachments(await window.ranparty.chooseFileData()) } catch (reason) { setError(messageOf(reason)) } }
  const browse = async () => { const path = await onBrowse(); if (!path) return; setWorkspace(path); setLocalWorkspaces(current => current.includes(path) ? current : [path, ...current]) }
  const create = async () => {
    if ((!prompt.trim() && !attachments.length) || !workspace || !profileName || creating) return
    setCreating(true); setError('')
    const payload = {
      prompt: prompt.trim(), workspace, profileName, approvalMode, mode,
      imageDataUrls: attachments.filter(isImageAttachment).map(item => item.dataUrl),
      fileDataUrls: attachments.filter(item => !isImageAttachment(item)).map(item => ({ name: item.name, dataUrl: item.dataUrl, mimeType: item.mimeType || attachmentMimeType(item.name) })),
    }
    const fingerprint = JSON.stringify(payload)
    if (submitRef.current?.fingerprint !== fingerprint) submitRef.current = { fingerprint, id: `task_${Date.now()}_${Math.random().toString(36).slice(2, 9)}` }
    try { await onCreate({ ...payload, clientMessageId: submitRef.current.id }); submitRef.current = null; onClose() }
    catch (reason) { setError(messageOf(reason)) }
    finally { setCreating(false) }
  }
  const options = useMemo(() => [...new Set([...(workspace ? [workspace] : []), ...localWorkspaces, ...workspaces])], [workspace, localWorkspaces, workspaces])
  const canCreate = Boolean((prompt.trim() || attachments.length) && workspace && profileName && !creating)

  return <section className={`new-task-page task-entry-page ${dragActive ? 'drag-active' : ''}`} role="main" aria-label="新建任务" onDragEnter={event => { event.preventDefault(); if (event.dataTransfer.types.includes('Files')) setDragActive(true) }} onDragOver={event => event.preventDefault()} onDragLeave={event => { if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) setDragActive(false) }} onDrop={event => void drop(event)}>
    {dragActive ? <div className="attachment-drop-feedback page-drop-feedback" role="status"><FileText size={24} /><strong>松开以添加文件</strong><small>最多 8 个附件，总计不超过 25MB</small></div> : null}
    <header className="new-task-page-header"><button className="icon-button" type="button" onClick={close} aria-label="返回"><ArrowLeft size={20} /></button><div><h1>新建任务</h1><p>{workspace ? `将在 ${workspaceName(workspace)} 中开始` : '先描述目标，再选择工作区和模型。'}</p></div></header>
    <div className="task-entry-stage">
      <div className="task-entry-hero"><span className="task-logo"><Sparkles size={21} /></span><h2>今天想让 AI 帮你做什么？</h2><p>从一句目标开始；工作区和模型始终在发送栏内可见。</p></div>
      <div className="task-quick-starts" aria-label="快捷开始">{QUICK_STARTS.map(item => <button type="button" key={item.title} onClick={() => { if (!prompt.trim()) setPrompt(item.prompt) }}><Sparkles size={15} /><strong>{item.title}</strong><span>{item.copy}</span></button>)}</div>
      <div className="task-composer-card">
        <textarea autoFocus value={prompt} onChange={event => setPrompt(event.target.value)} onPaste={event => void paste(event)} placeholder="例如：审查当前项目并给出改进方案；也可以直接粘贴截图。" rows={4} aria-label="新任务描述" />
        <AttachmentStrip className="task-attachments" attachments={attachments} onRemove={index => setAttachments(current => current.filter((_, candidate) => candidate !== index))} />
        {error ? <div className="new-task-error" role="alert">{error}<button type="button" aria-label="关闭错误" onClick={() => setError('')}><X size={12} /></button></div> : null}
        <footer className="task-composer-actions task-send-controls">
          <div className="task-send-left"><button type="button" className="round-icon-button muted" onClick={() => void chooseImages()} title="添加图片" aria-label="添加图片"><ImagePlus size={17} /></button><button type="button" className="round-icon-button muted" onClick={() => void chooseFiles()} title="添加文件" aria-label="添加文件"><FileText size={17} /></button><TaskPicker icon={<ShieldCheck size={13} />} label={approvalMode === 'auto' ? '自动通过' : '请求批准'} value={approvalMode} items={[{ value: 'ask', label: '请求批准' }, { value: 'auto', label: '自动通过后续操作' }]} onChange={value => setApprovalMode(value as 'ask' | 'auto')} /><TaskPicker icon={<WandSparkles size={13} />} label={MODES.find(item => item.value === mode)?.label ?? '默认模式'} value={mode} items={MODES.map(item => ({ value: item.value, label: item.label }))} onChange={value => setMode(value as SessionMode)} /><TaskPicker icon={<FolderOpen size={13} />} label={workspace ? workspaceName(workspace) : '选择工作区'} value={workspace} required={!workspace} items={options.map(item => ({ value: item, label: workspaceName(item), detail: item }))} onChange={setWorkspace} onBrowse={() => void browse()} /></div>
          <div className="task-send-right"><TaskPicker icon={<Sparkles size={13} />} label={profileName || '选择模型'} value={profileName} items={profiles.map(profile => ({ value: profile.name, label: profile.name, detail: profile.model }))} onChange={setProfileName} align="right" /><button className="primary-button task-start-button" disabled={!canCreate} onClick={() => void create()}>{creating ? <LoaderCircle className="spin" size={15} /> : <Sparkles size={15} />}{creating ? '正在创建…' : '开始任务'}</button></div>
        </footer>
      </div>
      <p className="task-entry-hint">支持直接粘贴或拖入图片、文档、数据文件和常见源码。</p>
    </div>
  </section>
}

function messageOf(reason: unknown) { return reason instanceof Error ? reason.message : String(reason) }

/** @deprecated Use NewTaskPage. */
export const NewTaskModal = NewTaskPage

function TaskPicker({ icon, label, value, items, onChange, onBrowse, required = false, align = 'left' }: { icon: ReactNode; label: string; value: string; items: Array<{ value: string; label: string; detail?: string }>; onChange: (value: string) => void; onBrowse?: () => void; required?: boolean; align?: 'left' | 'right' }) {
  const [open, setOpen] = useState(false)
  const menuId = useId()
  const triggerRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (open) queueMicrotask(() => menuRef.current?.querySelector<HTMLButtonElement>('button')?.focus())
  }, [open])
  const closeAndRestoreFocus = () => {
    setOpen(false)
    queueMicrotask(() => triggerRef.current?.focus())
  }
  const keyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape' && open) {
      event.preventDefault()
      event.stopPropagation()
      closeAndRestoreFocus()
      return
    }
    if (!open || !['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
    const options = Array.from(menuRef.current?.querySelectorAll<HTMLButtonElement>('button') ?? [])
    if (!options.length) return
    event.preventDefault()
    const current = Math.max(0, options.indexOf(document.activeElement as HTMLButtonElement))
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? options.length - 1 : event.key === 'ArrowDown' ? (current + 1) % options.length : (current - 1 + options.length) % options.length
    options[next].focus()
  }
  return <div className="popover-anchor task-picker-anchor" onKeyDown={keyDown} onBlur={event => { if (open && !event.currentTarget.contains(event.relatedTarget as Node | null)) setOpen(false) }}><button ref={triggerRef} type="button" className={`task-mini-select ${required ? 'required' : ''}`} aria-haspopup="menu" aria-controls={open ? menuId : undefined} aria-expanded={open} onClick={() => setOpen(current => !current)}>{icon}<span>{label}</span><ChevronDown size={12} /></button>{open ? <div ref={menuRef} id={menuId} className={`mini-select-menu task-picker-menu ${align === 'right' ? 'right' : ''}`} role="menu">{items.map(item => <button type="button" role="menuitemradio" aria-checked={item.value === value} key={item.value} onClick={() => { onChange(item.value); closeAndRestoreFocus() }}><Check size={13} className={item.value === value ? '' : 'invisible'} /><span>{item.label}{item.detail ? <small>{item.detail}</small> : null}</span></button>)}{onBrowse ? <button type="button" role="menuitem" className="browse" onClick={() => { onBrowse(); setOpen(false) }}><FolderOpen size={13} /><span>浏览文件夹…<small>选择本机目录作为工作区</small></span></button> : null}</div> : null}</div>
}
