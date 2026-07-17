import { ExternalLink, ShieldAlert, X } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ElicitationRequest } from '../types'

interface Props {
  request: ElicitationRequest
  onRespond: (action: 'accept' | 'decline' | 'cancel', content?: Record<string, unknown>) => Promise<void>
}

export function ElicitationDialog({ request, onRespond }: Props) {
  const [values, setValues] = useState<Record<string, unknown>>({})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const dialogRef = useRef<HTMLElement>(null)
  const declineRef = useRef<HTMLButtonElement>(null)
  const openerRef = useRef<HTMLElement | null>(typeof document === 'undefined' ? null : document.activeElement as HTMLElement | null)
  const properties = useMemo(() => (request.requestedSchema?.properties ?? {}) as Record<string, Record<string, unknown>>, [request])
  const required = useMemo(() => new Set(Array.isArray(request.requestedSchema?.required) ? request.requestedSchema.required as string[] : []), [request.requestedSchema?.required])

  const submit = useCallback(async (action: 'accept' | 'decline' | 'cancel') => {
    if (busy) return
    if (action === 'accept' && request.mode === 'form') {
      const missing = [...required].filter(name => values[name] === undefined || values[name] === null || values[name] === '')
      if (missing.length) {
        setError(`请完成必填项：${missing.map(name => String(properties[name]?.title ?? name)).join('、')}`)
        return
      }
    }
    setBusy(true)
    setError('')
    try {
      if (action === 'accept' && request.mode === 'url' && request.url) await window.ranparty.pathAction('open', request.url)
      await onRespond(action, action === 'accept' && request.mode === 'form' ? values : undefined)
    } catch (reason) {
      setError(`提交失败：${reason instanceof Error ? reason.message : String(reason)}`)
    } finally {
      setBusy(false)
    }
  }, [busy, onRespond, properties, request.mode, request.url, required, values])

  useEffect(() => {
    declineRef.current?.focus()
    const layer = dialogRef.current?.parentElement
    const parent = layer?.parentElement
    const siblings = layer && parent ? Array.from(parent.children).filter((element): element is HTMLElement => element instanceof HTMLElement && element !== layer) : []
    const previous = siblings.map(element => ({ element, inert: element.hasAttribute('inert'), ariaHidden: element.getAttribute('aria-hidden') }))
    for (const { element } of previous) { element.setAttribute('inert', ''); element.setAttribute('aria-hidden', 'true') }
    return () => {
      for (const item of previous) {
        if (!item.inert) item.element.removeAttribute('inert')
        if (item.ariaHidden === null) item.element.removeAttribute('aria-hidden')
        else item.element.setAttribute('aria-hidden', item.ariaHidden)
      }
      openerRef.current?.focus()
    }
  }, [])

  const handleKeyDown = (event: React.KeyboardEvent<HTMLElement>) => {
    if (event.key === 'Escape' && !busy) {
      event.preventDefault()
      void submit('cancel')
      return
    }
    if (event.key !== 'Tab') return
    const focusable = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])') ?? [])
    if (!focusable.length) return
    const first = focusable[0]
    const last = focusable[focusable.length - 1]
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus() }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
  }

  return <div className="elicitation-layer" role="presentation">
    <section ref={dialogRef} className="elicitation-dialog" role="dialog" aria-modal="true" aria-labelledby="elicitation-title" aria-describedby="elicitation-message" onKeyDown={handleKeyDown}>
      <header><div><ShieldAlert size={18} /><h3 id="elicitation-title">连接器需要你的输入</h3></div><button className="icon-button" aria-label="取消" disabled={busy} onClick={() => void submit('cancel')}><X size={18} /></button></header>
      <p id="elicitation-message">{request.message}</p>
      {request.mode === 'url' ? <div className="elicitation-url"><span>{request.url}</span><small>仅在你确认后使用系统浏览器打开；RanParty 不读取网页中提交的敏感信息。</small></div> : <div className="elicitation-form">{Object.entries(properties).map(([name, schema]) => {
        const label = String(schema.title ?? name)
        const description = String(schema.description ?? '')
        const sensitive = /password|secret|token|credential|key/i.test(`${name} ${label}`)
        const type = String(schema.type ?? 'string')
        const options = Array.isArray(schema.enum) ? schema.enum as string[] : []
        return <label key={name}><span>{label}{required.has(name) ? ' *' : ''}</span>{options.length ? <select value={String(values[name] ?? '')} onChange={(event) => setValues({ ...values, [name]: event.target.value })}><option value="">请选择</option>{options.map((option) => <option key={option}>{option}</option>)}</select> : type === 'boolean' ? <input type="checkbox" checked={Boolean(values[name])} onChange={(event) => setValues({ ...values, [name]: event.target.checked })} /> : <input type={sensitive ? 'password' : type === 'number' || type === 'integer' ? 'number' : 'text'} value={String(values[name] ?? '')} min={schema.minimum as number | undefined} max={schema.maximum as number | undefined} onChange={(event) => setValues({ ...values, [name]: type === 'number' || type === 'integer' ? Number(event.target.value) : event.target.value })} />}{description ? <small>{description}</small> : null}</label>
      })}</div>}
      {error ? <div className="elicitation-error" role="alert">{error}</div> : null}
      <footer><button ref={declineRef} className="outline-button" disabled={busy} onClick={() => void submit('decline')}>拒绝</button><button className="primary-button" disabled={busy} onClick={() => void submit('accept')}>{request.mode === 'url' ? <><ExternalLink size={15} />打开并继续</> : '提交'}</button></footer>
    </section>
  </div>
}
