import { CheckCircle2, Circle, LoaderCircle, ListTodo } from 'lucide-react'
import { useState } from 'react'
import type { PlanStep } from '../types'

interface Props {
  plan: PlanStep[]
  explanation?: string
  actionable?: boolean
  onAccept?: (planText: string) => void | Promise<void>
  onRevise?: (planText: string) => void
  onCancel?: () => void
}

const STATUS_LABEL: Record<PlanStep['status'], string> = {
  pending: '待处理',
  in_progress: '进行中',
  completed: '已完成',
}

export function PlanCard({ plan, explanation, actionable, onAccept, onRevise, onCancel }: Props) {
  const [submitting, setSubmitting] = useState(false)
  const total = plan.length
  const done = plan.filter((item) => item.status === 'completed').length
  const pct = total > 0 ? Math.round((done / total) * 100) : 0
  const allDone = total > 0 && done === total
  const planText = [explanation, ...plan.map((item, index) => `${index + 1}. ${item.step}`)].filter(Boolean).join('\n')
  const accept = async () => {
    if (submitting || !onAccept) return
    setSubmitting(true)
    try { await onAccept(planText) }
    catch { /* The parent surface owns actionable error reporting. */ }
    finally { setSubmitting(false) }
  }
  return (
    <article className={`plan-card ${allDone ? 'plan-done' : ''}`}>
      <header>
        <span className="plan-icon"><ListTodo size={18} /></span>
        <div className="plan-head-text">
          <strong>{allDone ? '计划已全部完成' : '任务计划'}</strong>
          <small>{done}/{total} 步完成 · {pct}%</small>
        </div>
        <div className="plan-progress"><div className="plan-progress-fill" style={{ width: `${pct}%` }} /></div>
      </header>
      {explanation ? <p className="plan-explanation">{explanation}</p> : null}
      <ol className="plan-steps">
        {plan.map((item, index) => (
          <li key={index} className={`plan-step ${item.status}`}>
            <span className="plan-step-icon">
              {item.status === 'completed' ? <CheckCircle2 size={16} />
                : item.status === 'in_progress' ? <LoaderCircle size={16} className="spin" />
                : <Circle size={16} />}
            </span>
            <span className="plan-step-text">{item.step}</span>
            <span className="plan-step-status">{STATUS_LABEL[item.status]}</span>
          </li>
        ))}
      </ol>
      {actionable ? <footer className="plan-actions">
        <button type="button" className="primary-button" disabled={submitting} onClick={() => void accept()}>{submitting ? <><LoaderCircle className="spin" size={14} />正在提交…</> : '同意执行'}</button>
        <button type="button" className="outline-button" disabled={submitting} onClick={() => onRevise?.(planText)}>修改计划</button>
        <button type="button" className="ghost-button" disabled={submitting} onClick={onCancel}>取消</button>
      </footer> : null}
    </article>
  )
}
