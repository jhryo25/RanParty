import { AppWindow, Clipboard, Copy, ExternalLink, FolderOpen } from 'lucide-react'
import { useEffect } from 'react'

export interface ResourceMenuState { target: string; x: number; y: number }

export function FileContextMenu({ menu, onClose, onError }: { menu: ResourceMenuState; onClose: () => void; onError?: (message: string) => void }) {
  const isUrl = /^https?:\/\//i.test(menu.target)
  const canUseBrowser = isUrl || /\.html?$/i.test(menu.target)
  useEffect(() => {
    const close = () => onClose()
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose() }
    window.addEventListener('click', close); window.addEventListener('keydown', key)
    return () => { window.removeEventListener('click', close); window.removeEventListener('keydown', key) }
  }, [onClose])
  const run = async (action: 'open' | 'open-with' | 'copy-path' | 'copy-file' | 'open-browser') => {
    try { await window.ranparty.pathAction(action, menu.target) }
    catch (error) { onError?.(error instanceof Error ? error.message : String(error)) }
    finally { onClose() }
  }
  return <div className="resource-context-menu" style={{ left: Math.min(menu.x, window.innerWidth - 220), top: Math.min(menu.y, window.innerHeight - 230) }} onClick={(event) => event.stopPropagation()} role="menu">
    <button onClick={() => void run('open')}><ExternalLink size={15} />默认程序打开</button>
    {!isUrl ? <button onClick={() => void run('open-with')}><AppWindow size={15} />选择打开方式</button> : null}
    <button onClick={() => void run('copy-path')}><Clipboard size={15} />{isUrl ? '复制链接' : '复制路径'}</button>
    {!isUrl ? <button onClick={() => void run('copy-file')}><Copy size={15} />复制文件</button> : null}
    {canUseBrowser ? <button onClick={() => void run('open-browser')}><FolderOpen size={15} />选择外部浏览器打开</button> : null}
  </div>
}
