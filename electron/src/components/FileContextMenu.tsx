import { Clipboard, ExternalLink } from 'lucide-react'
import { useEffect } from 'react'

export interface ResourceMenuState { target: string; x: number; y: number }

export function FileContextMenu({ menu, onClose, onError }: { menu: ResourceMenuState; onClose: () => void; onError?: (message: string) => void }) {
  const isUrl = /^https?:\/\//i.test(menu.target)
  useEffect(() => {
    const close = () => onClose()
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose() }
    window.addEventListener('click', close); window.addEventListener('keydown', key)
    return () => { window.removeEventListener('click', close); window.removeEventListener('keydown', key) }
  }, [onClose])
  const open = async () => {
    try {
      if (isUrl) await window.ranparty.pathAction('open', menu.target)
      else await window.ranparty.request('path.open', { path: menu.target })
    }
    catch (error) { onError?.(error instanceof Error ? error.message : String(error)) }
    finally { onClose() }
  }
  const copy = async () => {
    try { await window.ranparty.clipboardWrite(menu.target) }
    catch (error) { onError?.(error instanceof Error ? error.message : String(error)) }
    finally { onClose() }
  }
  return <div className="resource-context-menu" style={{ left: Math.min(menu.x, window.innerWidth - 220), top: Math.min(menu.y, window.innerHeight - 230) }} onClick={(event) => event.stopPropagation()} role="menu">
    <button onClick={() => void open()}><ExternalLink size={15} />{isUrl ? '在外部浏览器打开' : '经工作区授权打开'}</button>
    <button onClick={() => void copy()}><Clipboard size={15} />{isUrl ? '复制链接' : '复制路径'}</button>
  </div>
}
