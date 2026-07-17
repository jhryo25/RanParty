import { AlertTriangle, Bot, LoaderCircle, RefreshCw, Square, UserRound } from 'lucide-react'
import { memo, type MouseEvent } from 'react'
import { MarkdownBody } from './TranscriptMarkdown'
import { PlanCard } from './PlanCard'
import type { AssistantMessageItem, ThreadItem, UserMessageItem } from '../types'
import {
  isAssistantMessage,
  isContextCompaction,
  isError,
  isPlanStep,
  isSystemNotice,
  isToolResult,
  isUserMessage,
} from '../types'

interface ItemBlockProps {
  item: ThreadItem
  displayName: string
  onOpenResource: (target: string) => void
  onContextResource: (event: MouseEvent, target: string) => void
  actionablePlan?: boolean
  onAcceptPlan?: (planText: string) => void
  onRevisePlan?: (planText: string) => void
  onCancelPlan?: () => void
  displayPlan?: boolean
}

interface UserBlockProps {
  item: UserMessageItem
  onOpenResource: (target: string) => void
  onContextResource: (event: MouseEvent, target: string) => void
}

interface AssistantBlockProps {
  item: AssistantMessageItem
  displayName: string
  onOpenResource: (target: string) => void
  onContextResource: (event: MouseEvent, target: string) => void
  actionablePlan?: boolean
  onAcceptPlan?: (planText: string) => void
  onRevisePlan?: (planText: string) => void
  onCancelPlan?: () => void
}

interface SystemNoticeProps { content: string; variant?: 'info' | 'error' }
interface EmptyStateProps { displayName: string }

export function TranscriptItemBlock({ item, displayName, onOpenResource, onContextResource, actionablePlan, onAcceptPlan, onRevisePlan, onCancelPlan, displayPlan }: ItemBlockProps) {
  if (isSystemNotice(item)) return <SystemNotice content={item.content} variant={item.status === 'failed' ? 'error' : 'info'} />
  if (isPlanStep(item)) return displayPlan ? <PlanCard plan={item.steps} explanation={item.explanation} actionable={actionablePlan} onAccept={onAcceptPlan} onRevise={onRevisePlan} onCancel={onCancelPlan} /> : <SystemNotice content="此历史计划仅在 Plan 或 Goal 模式中显示。" />
  if (isToolResult(item)) return null
  if (isContextCompaction(item)) return <SystemNotice content={`上下文已压缩 (${item.tokensBefore} → ${item.tokensAfter} Token)`} />
  if (isUserMessage(item)) return <UserBlock item={item} onOpenResource={onOpenResource} onContextResource={onContextResource} />
  if (isAssistantMessage(item)) return <AssistantBlock item={item} displayName={displayName} onOpenResource={onOpenResource} onContextResource={onContextResource} actionablePlan={actionablePlan} onAcceptPlan={onAcceptPlan} onRevisePlan={onRevisePlan} onCancelPlan={onCancelPlan} />
  if (isError(item)) return <SystemNotice content={item.message} variant="error" />
  return null
}

const UserBlock = memo(function UserBlock({ item, onOpenResource, onContextResource }: UserBlockProps) {
  return <article className="message user-message">
    <div className="avatar user-avatar"><UserRound size={17} /></div>
    <div className="message-content">
      {item.images?.length ? <div className="message-images">{item.images.map((image, index) => <img className="message-image" key={`${item.id}-${index}`} src={image} alt={`附件 ${index + 1}`} />)}</div> : null}
      <div className="markdown-body"><MarkdownBody content={item.content} onOpenResource={onOpenResource} onContextResource={onContextResource} /></div>
    </div>
  </article>
})

const AssistantBlock = memo(function AssistantBlock({ item, displayName, onOpenResource, onContextResource, actionablePlan, onAcceptPlan, onRevisePlan, onCancelPlan }: AssistantBlockProps) {
  if (!item.streaming && !item.content.trim() && item.hasToolCalls) return null
  const empty = !item.streaming && !item.content.trim()
  return <article className={`message assistant-message ${item.error ? 'message-error' : ''}`}>
    <div className="avatar assistant-avatar"><Bot size={18} /></div>
    <div className="message-content">
      <div className="message-meta">
        <strong>{displayName}</strong>
        {item.streaming ? <span className="generating"><LoaderCircle size={13} />正在生成</span> : null}
        {item.status === 'cancelled' ? <span className="message-cancelled"><Square size={11} />已停止</span> : null}
      </div>
      {item.reasoning ? item.streaming ? <div className="thinking-live">
        <div className="thinking-fade" />
        <div className="thinking-stream">{item.reasoning.slice(-500)}</div>
        <span className="thinking-timer"><LoaderCircle className="spin" size={11} />思考中</span>
      </div> : <details className="thinking-done"><summary>已思考</summary><p>{item.reasoning}</p></details> : null}
      <div className="markdown-body">{empty ? item.hasToolCalls ? <span className="empty-response">—</span> : null : <MarkdownBody content={item.content} onOpenResource={onOpenResource} onContextResource={onContextResource} />}</div>
      {item.usageIn || item.usageOut ? <details className="usage-details"><summary>模型与用量</summary><div className="usage-line">{item.model} · 输入 {item.usageIn ?? 0} · 输出 {item.usageOut ?? 0}</div></details> : null}
      {actionablePlan ? <div className="plan-actions inline-plan-actions">
        <button type="button" className="primary-button" onClick={() => onAcceptPlan?.(item.content)}>同意执行</button>
        <button type="button" className="outline-button" onClick={() => onRevisePlan?.(item.content)}>修改计划</button>
        <button type="button" className="ghost-button" onClick={onCancelPlan}>取消</button>
      </div> : null}
    </div>
  </article>
})

function SystemNotice({ content, variant = 'info' }: SystemNoticeProps) {
  return <div className={`system-notice ${variant}`} role={variant === 'error' ? 'alert' : 'status'}>{variant === 'error' ? <AlertTriangle size={13} /> : <RefreshCw size={13} />}<span>{content}</span></div>
}

export function TranscriptEmptyState({ displayName }: EmptyStateProps) {
  return <div className="empty-chat">
    <div className="empty-mark"><Bot size={24} /></div>
    <h2>和 {displayName} 开始一个任务</h2>
    <p>选择工作区、模型和需要注入的 Skill，然后直接描述你想完成的事。</p>
  </div>
}
