import { AlertTriangle, Check, FolderOpen, Shield, ShieldAlert, ShieldCheck, TerminalSquare, X } from 'lucide-react'
import { useState } from 'react'
import type { ApprovalDecision, ApprovalRequest } from '../types'

interface Props {
  approval: ApprovalRequest
  onRespond: (action: ApprovalDecision, feedback?: string) => Promise<void>
}

export function ApprovalModal({ approval, onRespond }: Props) {
  const [submitting, setSubmitting] = useState(false)

  const respond = async (action: ApprovalDecision) => {
    setSubmitting(true)
    try { await onRespond(action) } finally { setSubmitting(false) }
  }

  const profileLabel: Record<string, string> = {
    ':read-only': '只读模式',
    ':workspace': '工作区模式',
    ':danger-full-access': '全权限模式',
  }

  const riskColors: Record<string, string> = {
    high: '#dc2626',
    medium: '#d97706',
    low: '#16a34a',
  }

  return (
    <div className="modal-layer">
      <div className="approval-modal" role="alertdialog" aria-modal="true" aria-labelledby="approval-title">
        <header>
          <span className="approval-icon">
            {approval.permissionProfile === ':danger-full-access' ? <ShieldAlert size={26} color="#dc2626" /> : <ShieldCheck size={26} />}
          </span>
          <div>
            <h2 id="approval-title">需要你的确认</h2>
            <p>
              即将运行 {approval.tool === 'ps_run' ? 'PowerShell' : 'Shell'} 命令
              {approval.permissionProfile ? (
                <span className="profile-badge" title={`当前权限模式：${profileLabel[approval.permissionProfile] ?? approval.permissionProfile}`}>
                  <Shield size={12} />
                  {profileLabel[approval.permissionProfile] ?? approval.permissionProfile}
                </span>
              ) : null}
            </p>
          </div>
        </header>

        {/* Guardian 自动评审 */}
        {approval.autoReview ? (
          <div className="approval-field auto-review" style={{ borderLeftColor: riskColors[approval.autoReview.risk] }}>
            <label><ShieldCheck size={15} />自动风险评审 — <span style={{ color: riskColors[approval.autoReview.risk], fontWeight: 600 }}>{approval.autoReview.risk === 'high' ? '高风险' : approval.autoReview.risk === 'medium' ? '中等风险' : '低风险'}</span></label>
            <small>{approval.autoReview.summary}</small>
          </div>
        ) : null}

        <div className="approval-field">
          <label><TerminalSquare size={15} />命令</label>
          <code>{approval.command}</code>
        </div>

        <div className="approval-field">
          <label>工作目录</label>
          <code>{approval.workdir || '当前工作区'}</code>
        </div>

        {approval.affectedPaths?.length ? (
          <div className="approval-field">
            <label><FolderOpen size={15} />受影响文件</label>
            <div className="affected-paths">
              {approval.affectedPaths.map((p) => <code key={p}>{p}</code>)}
            </div>
          </div>
        ) : null}

        {approval.reason ? (
          <div className="approval-field">
            <label>原因</label>
            <p className="approval-reason">{approval.reason}</p>
          </div>
        ) : null}

        <div className="risk-note">
          <AlertTriangle size={18} />
          <span>此命令将在本地执行，可能修改文件或影响系统配置。请确认命令来自可信来源。</span>
        </div>

        <footer>
          <button className="outline-button danger" disabled={submitting} onClick={() => void respond('reject')}>
            <X size={14} />拒绝
          </button>
          <button className="outline-button" disabled={submitting} onClick={() => void respond('allow_once')}>
            <Check size={14} />仅本次允许
          </button>
          <button className="outline-button" disabled={submitting} onClick={() => void respond('allow_session')}>
            <Check size={14} />本次会话允许
          </button>
          <button className="primary-button" disabled={submitting} onClick={() => void respond('allow_with_policy_amendment')}>
            <ShieldCheck size={14} />允许并记录策略
          </button>
        </footer>
      </div>
    </div>
  )
}
