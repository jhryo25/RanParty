import { Box, ChevronRight, File, Folder, FolderTree, PanelRightClose } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import type { Session, UiMessage, WorkspaceFile } from '../types'

export function RightPanel({ session, messages, onClose, onOpenPath }: { session: Session; messages: UiMessage[]; onClose: () => void; onOpenPath: (path: string) => void }) {
  const [tab, setTab] = useState<'products' | 'files'>('products')
  const [files, setFiles] = useState<WorkspaceFile[]>([])
  const products = useMemo(() => [...new Map(messages.filter(item => item.toolPath).map(item => [item.toolPath!, item])).values()], [messages])
  useEffect(() => {
    let cancelled = false
    window.ranparty.request<{ files: WorkspaceFile[] }>('workspace.files', { sessionId: session.id }).then(result => { if (!cancelled) setFiles(result.files) }).catch(() => { if (!cancelled) setFiles([]) })
    return () => { cancelled = true }
  }, [session.id, session.workspace, messages.length])
  return <aside className="right-panel">
    <header><nav><button className={tab === 'products' ? 'active' : ''} onClick={() => setTab('products')}><Box size={15} />产物</button><button className={tab === 'files' ? 'active' : ''} onClick={() => setTab('files')}><FolderTree size={15} />工作区文件</button></nav><button className="panel-close" onClick={onClose} title="收起右侧栏"><PanelRightClose size={18} /></button></header>
    <div className="right-panel-body">{tab === 'products' ? products.length ? products.map(item => <button className="artifact-row" key={item.toolPath} onClick={() => onOpenPath(item.toolPath!)}><File size={17} /><span><strong>{fileName(item.toolPath!)}</strong><small>{item.toolPath}</small></span><ChevronRight size={14} /></button>) : <div className="panel-empty"><Box size={34} /><strong>暂无产物</strong><p>AI 创建或修改的文件会显示在这里。</p></div> : files.length ? files.map(file => <button className={`file-row ${file.isDirectory ? 'directory' : ''}`} key={file.path} onClick={() => onOpenPath(file.path)}><span style={{ paddingLeft: `${Math.min(4, file.relativePath.split(/[\\/]/).length - 1) * 14}px` }}>{file.isDirectory ? <Folder size={16} /> : <File size={15} />}</span><strong>{file.name}</strong></button>) : <div className="panel-empty"><FolderTree size={34} /><strong>工作区为空</strong><p>选择工作区后可在这里浏览文件。</p></div>}</div>
  </aside>
}
function fileName(path: string) { return path.split(/[\\/]/).filter(Boolean).at(-1) ?? path }
