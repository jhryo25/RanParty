import { AlertTriangle, ShieldAlert, TerminalSquare } from 'lucide-react'
import { useState } from 'react'
import type { ApprovalRequest } from '../types'

interface Props {
  approval: ApprovalRequest
  onRespond: (action: 'reject' | 'allow_once' | 'allow_session', feedback?: string) => Promise<void>
}

export function ApprovalModal({ approval, onRespond }: Props) {
  const [submitting, setSubmitting] = useState(false)
  const respond = async (action: 'reject' | 'allow_once' | 'allow_session') => {
    setSubmitting(true)
    try { await onRespond(action) } finally { setSubmitting(false) }
  }
  return (
    <div className="modal-layer">
      <div className="approval-modal" role="alertdialog" aria-modal="true" aria-labelledby="approval-title">
        <header><span className="approval-icon"><ShieldAlert size={26} /></span><div><h2 id="approval-title">需要你的确认</h2><p>即将运行 {approval.tool === 'ps_run' ? 'PowerShell' : 'Shell'} 命令</p></div></header>
        <div className="approval-field"><label><TerminalSquare size={15} />命令</label><code>{approval.command}</code></div>
        <div className="approval-field"><label>工作目录</label><code>{approval.workdir || '当前工作区'}</code></div>
        <div className="risk-note"><AlertTriangle size={18} /><span>此命令将在本地执行，可能修改文件或影响系统配置。请确认命令来自可信来源。</span></div>
        <footer>
          <button className="outline-button" disabled={submitting} onClick={() => void respond('reject')}>拒绝</button>
          <button className="outline-button" disabled={submitting} onClick={() => void respond('allow_once')}>仅本次允许</button>
          <button className="primary-button" disabled={submitting} onClick={() => void respond('allow_session')}>允许此命令</button>
        </footer>
      </div>
    </div>
  )
}
