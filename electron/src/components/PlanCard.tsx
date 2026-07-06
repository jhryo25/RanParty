import { CheckCircle2, Circle, LoaderCircle, ListTodo } from 'lucide-react'
import type { PlanStep } from '../types'

interface Props {
  plan: PlanStep[]
  explanation?: string
}

const STATUS_LABEL: Record<PlanStep['status'], string> = {
  pending: '待处理',
  in_progress: '进行中',
  completed: '已完成',
}

export function PlanCard({ plan, explanation }: Props) {
  const total = plan.length
  const done = plan.filter((item) => item.status === 'completed').length
  const pct = total > 0 ? Math.round((done / total) * 100) : 0
  const allDone = total > 0 && done === total
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
    </article>
  )
}
