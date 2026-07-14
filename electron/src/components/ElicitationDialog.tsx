import { ExternalLink, ShieldAlert, X } from 'lucide-react'
import { useMemo, useState } from 'react'
import type { ElicitationRequest } from '../types'

export function ElicitationDialog({ request, onRespond }: { request: ElicitationRequest; onRespond: (action: 'accept' | 'decline' | 'cancel', content?: Record<string, unknown>) => Promise<void> }) {
  const [values, setValues] = useState<Record<string, unknown>>({})
  const [busy, setBusy] = useState(false)
  const properties = useMemo(() => (request.requestedSchema?.properties ?? {}) as Record<string, Record<string, unknown>>, [request])
  const required = new Set(Array.isArray(request.requestedSchema?.required) ? request.requestedSchema.required as string[] : [])
  const submit = async (action: 'accept' | 'decline' | 'cancel') => {
    setBusy(true)
    try {
      if (action === 'accept' && request.mode === 'url' && request.url) await window.ranparty.pathAction('open', request.url)
      await onRespond(action, action === 'accept' && request.mode === 'form' ? values : undefined)
    } finally { setBusy(false) }
  }
  return <div className="elicitation-layer" role="presentation">
    <section className="elicitation-dialog" role="dialog" aria-modal="true" aria-labelledby="elicitation-title">
      <header><div><ShieldAlert size={18} /><h3 id="elicitation-title">连接器需要你的输入</h3></div><button className="icon-button" aria-label="取消" onClick={() => void submit('cancel')}><X size={18} /></button></header>
      <p>{request.message}</p>
      {request.mode === 'url' ? <div className="elicitation-url"><span>{request.url}</span><small>仅在你确认后使用系统浏览器打开；RanParty 不读取网页中提交的敏感信息。</small></div> : <div className="elicitation-form">{Object.entries(properties).map(([name, schema]) => {
        const label = String(schema.title ?? name)
        const description = String(schema.description ?? '')
        const sensitive = /password|secret|token|credential|key/i.test(`${name} ${label}`)
        const type = String(schema.type ?? 'string')
        const options = Array.isArray(schema.enum) ? schema.enum as string[] : []
        return <label key={name}><span>{label}{required.has(name) ? ' *' : ''}</span>{options.length ? <select value={String(values[name] ?? '')} onChange={(event) => setValues({ ...values, [name]: event.target.value })}><option value="">请选择</option>{options.map((option) => <option key={option}>{option}</option>)}</select> : type === 'boolean' ? <input type="checkbox" checked={Boolean(values[name])} onChange={(event) => setValues({ ...values, [name]: event.target.checked })} /> : <input type={sensitive ? 'password' : type === 'number' || type === 'integer' ? 'number' : 'text'} value={String(values[name] ?? '')} min={schema.minimum as number | undefined} max={schema.maximum as number | undefined} onChange={(event) => setValues({ ...values, [name]: type === 'number' || type === 'integer' ? Number(event.target.value) : event.target.value })} />}{description ? <small>{description}</small> : null}</label>
      })}</div>}
      <footer><button className="outline-button" disabled={busy} onClick={() => void submit('decline')}>拒绝</button><button className="primary-button" disabled={busy} onClick={() => void submit('accept')}>{request.mode === 'url' ? <><ExternalLink size={15} />打开并继续</> : '提交'}</button></footer>
    </section>
  </div>
}
