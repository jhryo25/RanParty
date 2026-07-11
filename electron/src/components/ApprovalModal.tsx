import { AlertTriangle, Check, ChevronDown, FolderOpen, Shield, ShieldAlert, ShieldCheck, TerminalSquare, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { ApprovalDecision, ApprovalRequest } from '../types'

interface Props {
  approval: ApprovalRequest
  sessionTitle?: string
  onRespond: (action: ApprovalDecision, feedback?: string) => Promise<void>
}

export function ApprovalModal({ approval, sessionTitle, onRespond }: Props) {
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')
  const [detailsOpen, setDetailsOpen] = useState(false)
  const rejectRef = useRef<HTMLButtonElement>(null)

  const respond = async (action: ApprovalDecision) => {
    setSubmitting(true)
    setError('')
    try { await onRespond(action) }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)) }
    finally { setSubmitting(false) }
  }

  useEffect(() => {
    rejectRef.current?.focus()
    return () => {}
  }, [approval.approvalId])

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
      <div className="approval-modal" role="alertdialog" aria-modal="true" aria-labelledby="approval-title" aria-describedby="approval-risk-note">
        <header>
          <span className="approval-icon">
            {approval.permissionProfile === ':danger-full-access' ? <ShieldAlert size={26} color="#dc2626" /> : <ShieldCheck size={26} />}
          </span>
          <div>
            <h2 id="approval-title">需要你的确认</h2>
            <p>
              即将执行 {toolLabel(approval.tool)}
              {approval.permissionProfile ? (
                <span className="profile-badge" title={`当前权限模式：${profileLabel[approval.permissionProfile] ?? approval.permissionProfile}`}>
                  <Shield size={12} />
                  {profileLabel[approval.permissionProfile] ?? approval.permissionProfile}
                </span>
              ) : null}
              {sessionTitle ? <span className="approval-session"> · 会话：{sessionTitle}</span> : null}
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

        {!approval.autoReview && approval.risk ? (
          <div className="approval-field auto-review" style={{ borderLeftColor: riskColors[approval.risk] ?? '#d97706' }}>
            <label><ShieldCheck size={15} />风险级别 — <span style={{ color: riskColors[approval.risk] ?? '#a16207', fontWeight: 600 }}>{riskLabel(approval.risk)}</span></label>
            <small>策略版本 {approval.policyVersion ?? '当前'}{approval.sessionScoped ? ' · 本次允许范围仅限当前会话' : ''}</small>
          </div>
        ) : null}

        <div className="approval-field approval-command">
          <label><TerminalSquare size={15} />操作</label>
          <code>{approval.command || '持久化工具操作'}</code>
        </div>

        <button type="button" className="approval-details-toggle" aria-expanded={detailsOpen} onClick={() => setDetailsOpen(value => !value)}>查看详情<ChevronDown size={14} className={detailsOpen ? 'open' : ''} /></button>
        {detailsOpen ? <div className="approval-details">
          {approval.arguments ? <div className="approval-field"><label>工具参数</label><code>{formatArguments(approval.arguments)}</code></div> : null}
          <div className="approval-field"><label>工作目录</label><code>{approval.workdir || '当前工作区'}</code></div>
          {approval.affectedPaths?.length ? <div className="approval-field"><label><FolderOpen size={15} />受影响文件</label><div className="affected-paths">{approval.affectedPaths.map((p) => <code key={p}>{p}</code>)}</div></div> : null}
          {approval.reason ? <div className="approval-field"><label>原因</label><p className="approval-reason">{approval.reason}</p></div> : null}
        </div> : null}

        <div className="risk-note" id="approval-risk-note">
          <AlertTriangle size={18} />
          <span>此操作将在本地执行并可能产生持久副作用。请确认参数、影响范围和来源均符合预期。</span>
        </div>

        {error ? <div className="approval-error" role="alert">提交失败，审批仍待处理：{error}</div> : null}

        <footer>
          <button ref={rejectRef} className="outline-button danger" disabled={submitting} onClick={() => void respond('reject')}>
            <X size={14} />拒绝
          </button>
          <button className="outline-button" disabled={submitting} onClick={() => void respond('allow_once')}>
            <Check size={14} />仅本次允许
          </button>
          <button className="outline-button" disabled={submitting} onClick={() => void respond('allow_session')}>
            <Check size={14} />允许类似操作
          </button>
        </footer>
      </div>
    </div>
  )
}

function riskLabel(risk: string) {
  if (risk === 'high') return '高风险'
  if (risk === 'medium') return '中等风险'
  if (risk === 'low') return '低风险'
  if (risk === 'persistent_data') return '会修改持久数据'
  return risk
}

function toolLabel(tool: string) {
  if (tool === 'ps_run') return 'PowerShell 命令'
  if (tool === 'shell_run') return 'Shell 命令'
  if (tool.startsWith('memory_') || tool === 'lesson_capture' || tool === 'growth_record') return '长期记忆写入'
  if (tool === 'file_delete') return '文件删除'
  if (tool === 'file_move') return '文件移动'
  return `工具 ${tool}`
}

function formatArguments(value: unknown) {
  if (typeof value === 'string') return value
  try { return JSON.stringify(value, null, 2) }
  catch { return String(value) }
}
