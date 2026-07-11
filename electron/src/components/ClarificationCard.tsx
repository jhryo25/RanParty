import { HelpCircle, Send, Square } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { ClarificationRequest } from '../types'

interface Props {
  clarification: ClarificationRequest
  onRespond: (text: string, selection: string[]) => Promise<void>
  onCancel: () => void
}

export function ClarificationCard({ clarification, onRespond, onCancel }: Props) {
  const [text, setText] = useState('')
  const [selected, setSelected] = useState<string[]>([])
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const hasOptions = clarification.options.length > 0

  const respond = async (overrideText?: string, overrideSelection?: string[]) => {
    const answer = (overrideText ?? text).trim()
    const sel = overrideSelection ?? selected
    if (!answer && sel.length === 0) return
    setSubmitting(true)
    setError('')
    try { await onRespond(answer, sel) }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)) }
    finally { setSubmitting(false) }
  }

  useEffect(() => {
    inputRef.current?.focus()
    return () => {}
  }, [clarification.clarificationId])

  const toggle = (option: string) => {
    if (submitting) return
    if (clarification.multiSelect) {
      setSelected((current) => current.includes(option) ? current.filter((item) => item !== option) : [...current, option])
    } else {
      void respond('', [option])
    }
  }

  return (
    <div className="composer-wrap clarification-wrap">
      <div className="clarification-card" role="region" aria-labelledby={`clarification-${clarification.clarificationId}`}>
        <header>
          <span className="clarification-icon"><HelpCircle size={18} /></span>
          <div className="clarification-head-text">
            <strong id={`clarification-${clarification.clarificationId}`}>Agent 需要你确认后再继续</strong>
            <small>{clarification.context || '存在不确定事项，已暂停等待你的回复'}</small>
          </div>
        </header>
        <div className="clarification-question">{clarification.question}</div>
        {hasOptions ? (
          <div className="clarification-options">
            {clarification.options.map((option) => (
              <button key={option} type="button" className={`clarification-option ${selected.includes(option) ? 'selected' : ''}`} disabled={submitting} onClick={() => toggle(option)}>
                <span className="clarification-bullet" />{option}
              </button>
            ))}
          </div>
        ) : null}
        <div className="clarification-other">
          <textarea ref={inputRef} aria-label="澄清回复" placeholder="其他回答（自由输入）…" value={text} rows={2} disabled={submitting}
            onChange={(event) => setText(event.target.value)}
            onKeyDown={(event) => { if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') { event.preventDefault(); void respond() } }} />
          <button className="primary-button" disabled={submitting || (!text.trim() && selected.length === 0)} onClick={() => void respond()}>
            <Send size={14} />回复
          </button>
        </div>
        {error ? <small className="clarification-error" role="alert">回复失败，内容已保留：{error}</small> : null}
        {hasOptions ? (
          <small className="clarification-hint">
            {clarification.multiSelect ? '可多选，也可在下方输入其他回答后回复' : '点选选项即提交；或在下方输入其他回答后回复'}
          </small>
        ) : null}
        <button type="button" className="clarification-cancel ghost-button" disabled={submitting} onClick={onCancel}><Square size={12} />停止当前任务</button>
      </div>
    </div>
  )
}
