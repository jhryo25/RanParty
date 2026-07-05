import { ArrowLeft, ArrowRight, Box, ChevronRight, ExternalLink, File, FileCode2, Folder, FolderOpen, FolderTree, Globe2, LoaderCircle, MessageSquarePlus, PanelRightClose, Plus, RotateCw, Send, X } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { FileContextMenu, type ResourceMenuState } from './FileContextMenu'
import type { FilePreview, Session, UiMessage, WorkspaceFile } from '../types'

type BaseTab = 'products' | 'files'
type DynamicTab = { id: string; type: 'preview' | 'browser' | 'chat'; title: string; path?: string; url?: string }
type WebviewElement = HTMLElement & {
  loadURL: (url: string) => Promise<void>
  canGoBack: () => boolean
  canGoForward: () => boolean
  goBack: () => void
  goForward: () => void
  reload: () => void
}

interface Props {
  session: Session
  messages: UiMessage[]
  onClose: () => void
  onOpenPath: (path: string) => void
  onSendSide: (text: string) => Promise<void>
  onError?: (message: string) => void
}

export function RightPanel({ session, messages, onClose, onOpenPath, onSendSide, onError }: Props) {
  const [active, setActive] = useState<string>('products')
  const [tabs, setTabs] = useState<DynamicTab[]>([])
  const [files, setFiles] = useState<WorkspaceFile[]>([])
  const [preview, setPreview] = useState<FilePreview | null>(null)
  const [loadingPreview, setLoadingPreview] = useState(false)
  const [plusOpen, setPlusOpen] = useState(false)
  const [resourceMenu, setResourceMenu] = useState<ResourceMenuState | null>(null)
  const products = useMemo(() => [...new Map(messages.filter(item => item.toolPath).map(item => [item.toolPath!, item])).values()], [messages])
  const activeTab = tabs.find(tab => tab.id === active)

  useEffect(() => {
    let cancelled = false
    window.ranparty.request<{ files: WorkspaceFile[] }>('workspace.files', { sessionId: session.id }).then(result => { if (!cancelled) setFiles(result.files) }).catch(() => { if (!cancelled) setFiles([]) })
    return () => { cancelled = true }
  }, [session.id, session.workspace, messages.length])

  useEffect(() => {
    if (activeTab?.type !== 'preview' || !activeTab.path) { setPreview(null); return }
    let cancelled = false
    setLoadingPreview(true)
    window.ranparty.request<FilePreview>('path.preview', { path: activeTab.path }).then(result => { if (!cancelled) setPreview(result) }).catch(error => { if (!cancelled) onError?.(String(error)) }).finally(() => { if (!cancelled) setLoadingPreview(false) })
    return () => { cancelled = true }
  }, [activeTab?.id, activeTab?.path, activeTab?.type, onError])

  useEffect(() => {
    if (!plusOpen) return
    const close = () => setPlusOpen(false)
    window.addEventListener('click', close)
    return () => window.removeEventListener('click', close)
  }, [plusOpen])

  const openPreview = (path: string) => {
    const existing = tabs.find(tab => tab.type === 'preview' && tab.path === path)
    if (existing) { setActive(existing.id); return }
    const tab = { id: `preview_${Date.now()}`, type: 'preview' as const, title: fileName(path), path }
    setTabs(current => [...current, tab]); setActive(tab.id)
  }
  const addBrowser = () => { const tab = { id: `browser_${Date.now()}`, type: 'browser' as const, title: '浏览器', url: 'https://www.bing.com' }; setTabs(current => [...current, tab]); setActive(tab.id); setPlusOpen(false) }
  const addChat = () => { const tab = { id: `chat_${Date.now()}`, type: 'chat' as const, title: '侧边对话' }; setTabs(current => [...current, tab]); setActive(tab.id); setPlusOpen(false) }
  const addFile = async () => { const path = await window.ranparty.chooseFile(); setPlusOpen(false); if (path) openPreview(path) }
  const closeTab = (id: string) => { setTabs(current => current.filter(tab => tab.id !== id)); if (active === id) setActive('products') }
  const context = (event: React.MouseEvent, target: string) => { event.preventDefault(); setResourceMenu({ target, x: event.clientX, y: event.clientY }) }

  return <aside className="right-panel">
    <header className="right-panel-tabs"><nav>
      <PanelTab active={active === 'products'} label="产物" icon={<Box size={14} />} onClick={() => setActive('products')} />
      <PanelTab active={active === 'files'} label="工作区文件" icon={<FolderTree size={14} />} onClick={() => setActive('files')} />
      {tabs.map(tab => <button key={tab.id} className={active === tab.id ? 'active dynamic' : 'dynamic'} onClick={() => setActive(tab.id)} title={tab.path || tab.url || tab.title}>{tab.type === 'browser' ? <Globe2 size={14} /> : tab.type === 'chat' ? <MessageSquarePlus size={14} /> : <FileCode2 size={14} />}<span>{tab.title}</span><X size={12} onClick={(event) => { event.stopPropagation(); closeTab(tab.id) }} /></button>)}
      <div className="panel-plus-anchor" onClick={event => event.stopPropagation()}><button className="panel-plus" onClick={() => setPlusOpen(value => !value)} title="新建页签"><Plus size={16} /></button>{plusOpen ? <div className="panel-plus-menu"><button onClick={addBrowser}><Globe2 size={15} />浏览器</button><button onClick={() => void addFile()}><FolderOpen size={15} />档案预览</button><button onClick={addChat}><MessageSquarePlus size={15} />侧边对话</button></div> : null}</div>
    </nav><button className="panel-close" onClick={onClose} title="收起右侧栏"><PanelRightClose size={18} /></button></header>
    <div className="right-panel-body">
      {active === 'products' ? <ProductList products={products} openPreview={openPreview} onOpenPath={onOpenPath} onContext={context} /> : null}
      {active === 'files' ? <FileList files={files} openPreview={openPreview} onOpenPath={onOpenPath} onContext={context} /> : null}
      {activeTab?.type === 'preview' ? <PreviewPane preview={preview} loading={loadingPreview} onOpenPath={onOpenPath} onContext={context} /> : null}
      {activeTab?.type === 'browser' ? <BrowserPane tab={activeTab} onUpdate={url => setTabs(current => current.map(item => item.id === activeTab.id ? { ...item, url } : item))} /> : null}
      {activeTab?.type === 'chat' ? <SideChat messages={messages} onSend={onSendSide} /> : null}
    </div>
    {resourceMenu ? <FileContextMenu menu={resourceMenu} onClose={() => setResourceMenu(null)} onError={onError} /> : null}
  </aside>
}

function PanelTab({ active, label, icon, onClick }: { active: boolean; label: string; icon: React.ReactNode; onClick: () => void }) { return <button className={active ? 'active' : ''} onClick={onClick}>{icon}{label}</button> }

function ProductList({ products, openPreview, onOpenPath, onContext }: { products: UiMessage[]; openPreview: (path: string) => void; onOpenPath: (path: string) => void; onContext: (event: React.MouseEvent, target: string) => void }) {
  return products.length ? <div className="panel-list">{products.map(item => <button className="artifact-row" key={item.toolPath} onClick={() => previewable(item.toolPath!) ? openPreview(item.toolPath!) : onOpenPath(item.toolPath!)} onContextMenu={event => onContext(event, item.toolPath!)}><File size={17} /><span><strong>{fileName(item.toolPath!)}</strong><small>{item.toolPath}</small></span><ChevronRight size={14} /></button>)}</div> : <PanelEmpty icon={<Box size={34} />} title="暂无产物" copy="AI 创建或修改的文件会显示在这里。" />
}

function FileList({ files, openPreview, onOpenPath, onContext }: { files: WorkspaceFile[]; openPreview: (path: string) => void; onOpenPath: (path: string) => void; onContext: (event: React.MouseEvent, target: string) => void }) {
  return files.length ? <div className="panel-list">{files.map(file => <button className={`file-row ${file.isDirectory ? 'directory' : ''}`} key={file.path} onClick={() => file.isDirectory ? onOpenPath(file.path) : previewable(file.path) ? openPreview(file.path) : onOpenPath(file.path)} onContextMenu={event => onContext(event, file.path)}><span style={{ paddingLeft: `${Math.min(4, file.relativePath.split(/[\\/]/).length - 1) * 14}px` }}>{file.isDirectory ? <Folder size={16} /> : <File size={15} />}</span><strong>{file.name}</strong></button>)}</div> : <PanelEmpty icon={<FolderTree size={34} />} title="工作区为空" copy="选择工作区后可在这里浏览文件。" />
}

function PreviewPane({ preview, loading, onOpenPath, onContext }: { preview: FilePreview | null; loading: boolean; onOpenPath: (path: string) => void; onContext: (event: React.MouseEvent, target: string) => void }) {
  if (loading) return <PanelEmpty icon={<Loader />} title="正在加载预览" copy="请稍候…" />
  if (!preview) return <PanelEmpty icon={<FileCode2 size={34} />} title="无法预览" copy="没有可显示的文件内容。" />
  return <section className="preview-pane"><header><div><strong>{preview.name}</strong><small>{formatBytes(preview.size)} · {preview.path}</small></div><button onClick={() => onOpenPath(preview.path)} onContextMenu={event => onContext(event, preview.path)}>默认程序打开</button></header>
    {preview.kind === 'html' ? <iframe title={preview.name} sandbox="" srcDoc={preview.content} /> : null}
    {preview.kind === 'markdown' ? <div className="preview-markdown"><ReactMarkdown remarkPlugins={[remarkGfm]}>{preview.content || ''}</ReactMarkdown></div> : null}
    {preview.kind === 'text' ? <pre>{preview.content}</pre> : null}
    {preview.kind === 'image' ? <div className="preview-media"><img src={preview.dataUrl} alt={preview.name} /></div> : null}
    {preview.kind === 'pdf' ? <embed className="preview-pdf" src={preview.dataUrl} type="application/pdf" /> : null}
    {preview.kind === 'too_large' ? <PanelEmpty icon={<File size={32} />} title="文件太大，无法预览" copy={`${formatBytes(preview.size)}，超过 ${formatBytes(preview.limit || 0)} 预览上限。`} /> : null}
    {preview.kind === 'unsupported' ? <PanelEmpty icon={<File size={32} />} title="暂不支持此格式" copy="可以使用系统默认程序打开。" /> : null}
  </section>
}

function BrowserPane({ tab, onUpdate }: { tab: DynamicTab; onUpdate: (url: string) => void }) {
  const [draft, setDraft] = useState(tab.url || '')
  const [url, setUrl] = useState(tab.url || '')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [history, setHistory] = useState({ back: false, forward: false })
  const webviewRef = useRef<WebviewElement | null>(null)

  useEffect(() => {
    const view = webviewRef.current
    if (!view) return
    const syncHistory = () => setHistory({ back: view.canGoBack(), forward: view.canGoForward() })
    const navigated = (raw: Event) => {
      const next = String((raw as Event & { url?: string }).url || '')
      if (next) { setUrl(next); setDraft(next); onUpdate(next) }
      setError(''); setLoading(false); syncHistory()
    }
    const started = () => { setLoading(true); setError('') }
    const finished = () => { setLoading(false); syncHistory() }
    const failed = (raw: Event) => {
      const event = raw as Event & { errorCode?: number; errorDescription?: string }
      if (event.errorCode === -3) return
      setLoading(false); setError(event.errorDescription || '页面加载失败')
    }
    view.addEventListener('did-start-loading', started)
    view.addEventListener('did-finish-load', finished)
    view.addEventListener('did-navigate', navigated)
    view.addEventListener('did-navigate-in-page', navigated)
    view.addEventListener('did-fail-load', failed)
    return () => {
      view.removeEventListener('did-start-loading', started)
      view.removeEventListener('did-finish-load', finished)
      view.removeEventListener('did-navigate', navigated)
      view.removeEventListener('did-navigate-in-page', navigated)
      view.removeEventListener('did-fail-load', failed)
    }
  }, [onUpdate])

  const go = () => {
    const next = /^https?:\/\//i.test(draft.trim()) ? draft.trim() : `https://${draft.trim()}`
    if (!draft.trim()) return
    setUrl(next); setLoading(true); setError(''); onUpdate(next)
  }

  return <section className="browser-pane">
    <form onSubmit={event => { event.preventDefault(); go() }}>
      <button type="button" className="browser-icon" disabled={!history.back} onClick={() => webviewRef.current?.goBack()} title="后退"><ArrowLeft size={15} /></button>
      <button type="button" className="browser-icon" disabled={!history.forward} onClick={() => webviewRef.current?.goForward()} title="前进"><ArrowRight size={15} /></button>
      <button type="button" className="browser-icon" onClick={() => webviewRef.current?.reload()} title="刷新"><RotateCw size={14} /></button>
      <Globe2 size={14} /><input value={draft} onChange={event => setDraft(event.target.value)} aria-label="浏览器地址" /><button>前往</button><button type="button" className="browser-icon" onClick={() => void window.ranparty.pathAction('open', url)} title="外部打开"><ExternalLink size={14} /></button>
    </form>
    <div className="browser-view">{loading ? <div className="browser-loading"><LoaderCircle className="spin" size={20} />正在加载页面…</div> : null}{error ? <div className="browser-error"><strong>页面加载失败</strong><span>{error}</span><button onClick={() => webviewRef.current?.reload()}>重试</button></div> : null}<webview ref={node => { webviewRef.current = node as WebviewElement | null }} src={url} partition="persist:ranparty-browser" webpreferences="contextIsolation=yes,sandbox=yes" /></div>
  </section>
}

function SideChat({ messages, onSend }: { messages: UiMessage[]; onSend: (text: string) => Promise<void> }) {
  const [text, setText] = useState(''); const [sending, setSending] = useState(false)
  const submit = async () => { const value = text.trim(); if (!value || sending) return; setSending(true); try { await onSend(value); setText('') } finally { setSending(false) } }
  return <section className="side-chat"><header><strong>侧边对话</strong><small>与当前会话共享上下文</small></header><div>{messages.slice(-8).map(message => message.role === 'user' || message.role === 'assistant' ? <article key={message.id} className={message.role}><strong>{message.role === 'user' ? '你' : 'AI'}</strong><p>{message.content || (message.streaming ? '正在生成…' : '')}</p></article> : null)}</div><footer><textarea value={text} onChange={event => setText(event.target.value)} placeholder="继续当前对话…" /><button disabled={!text.trim() || sending} onClick={() => void submit()}><Send size={15} /></button></footer></section>
}

function PanelEmpty({ icon, title, copy }: { icon: React.ReactNode; title: string; copy: string }) { return <div className="panel-empty">{icon}<strong>{title}</strong><p>{copy}</p></div> }
function Loader() { return <span className="panel-loader" /> }
function previewable(path: string) { return /\.(html?|md|markdown|txt|jsonl?|csv|log|xml|ya?ml|cs|tsx?|jsx?|css|py|ps1|sh|png|jpe?g|gif|webp|bmp|svg|pdf)$/i.test(path) }
function fileName(path: string) { return path.split(/[\\/]/).filter(Boolean).at(-1) ?? path }
function formatBytes(value: number) { if (value < 1024) return `${value} B`; if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`; return `${(value / 1024 / 1024).toFixed(1)} MB` }
