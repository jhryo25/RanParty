import { Cable, Check, CircleAlert, FileUp, Loader2, Plus, RefreshCw, Save, TestTube2, Trash2 } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import type { ConnectorCatalogEntry, ConnectorConfig } from '../types'

type CatalogTab = 'tools' | 'resources' | 'prompts' | 'logs'

const blankConnector = (): ConnectorConfig => ({
  id: '', name: '', enabled: false, type: 'stdio', command: '', args: [], cwd: '', url: '',
  auth: 'none', approvalMode: 'ask', enabledTools: [], pinnedTools: [], toolPolicies: {},
  connectTimeoutSeconds: 15, toolTimeoutSeconds: 60, supportsParallelToolCalls: false,
  sampling: { enabled: false, requestsPerMinute: 10, maxTokens: 4096, timeoutSeconds: 30, maxToolRounds: 0 },
})

export function ConnectorSettings({ onDirtyChange }: { onDirtyChange?: (dirty: boolean) => void }) {
  const [connectors, setConnectors] = useState<ConnectorConfig[]>([])
  const [selectedId, setSelectedId] = useState('')
  const [draft, setDraft] = useState<ConnectorConfig>(blankConnector)
  const [envText, setEnvText] = useState('')
  const [headerText, setHeaderText] = useState('')
  const [catalog, setCatalog] = useState<Record<CatalogTab, ConnectorCatalogEntry[]>>({ tools: [], resources: [], prompts: [], logs: [] })
  const [tab, setTab] = useState<CatalogTab>('tools')
  const [busy, setBusy] = useState('')
  const [notice, setNotice] = useState('')

  const selected = useMemo(() => connectors.find((item) => item.id === selectedId), [connectors, selectedId])
  const dirty = useMemo(() => {
    const baseline = selected
      ? { ...selected, args: [...(selected.args ?? [])], enabledTools: [...(selected.enabledTools ?? [])], pinnedTools: [...(selected.pinnedTools ?? [])], toolPolicies: { ...(selected.toolPolicies ?? {}) } }
      : blankConnector()
    const baselineEnv = selected ? Object.keys(selected.envSecretRefs ?? {}).map((key) => `${key}=********`).join('\n') : ''
    const baselineHeaders = selected ? Object.keys(selected.headerSecretRefs ?? {}).map((key) => `${key}=********`).join('\n') : ''
    return JSON.stringify(draft) !== JSON.stringify(baseline) || envText !== baselineEnv || headerText !== baselineHeaders
  }, [draft, envText, headerText, selected])

  useEffect(() => {
    onDirtyChange?.(dirty)
    return () => onDirtyChange?.(false)
  }, [dirty, onDirtyChange])

  const reload = async (preferId?: string) => {
    const result = await window.ranparty.request<{ connectors: ConnectorConfig[] }>('connectors.list', {})
    setConnectors(result.connectors)
    const nextId = preferId || selectedId || result.connectors[0]?.id || ''
    setSelectedId(nextId)
  }

  useEffect(() => { void reload() }, [])
  useEffect(() => {
    if (!selected) return
    setDraft({ ...selected, args: [...(selected.args ?? [])], enabledTools: [...(selected.enabledTools ?? [])], pinnedTools: [...(selected.pinnedTools ?? [])], toolPolicies: { ...(selected.toolPolicies ?? {}) } })
    setEnvText(Object.keys(selected.envSecretRefs ?? {}).map((key) => `${key}=********`).join('\n'))
    setHeaderText(Object.keys(selected.headerSecretRefs ?? {}).map((key) => `${key}=********`).join('\n'))
    setCatalog({ tools: [], resources: [], prompts: [], logs: [] })
  }, [selected])

  const parsePairs = (value: string) => Object.fromEntries(value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map((line) => {
    const split = line.indexOf('=')
    return split < 1 ? [line, ''] : [line.slice(0, split).trim(), line.slice(split + 1)]
  }))

  const save = async (nextDraft = draft) => {
    setBusy('save'); setNotice('')
    try {
      const payload = { ...nextDraft, env: parsePairs(envText), headers: parsePairs(headerText) }
      const result = await window.ranparty.request<{ connector: ConnectorConfig }>('connectors.save', { connector: payload })
      await reload(result.connector.id)
      setNotice('连接器配置已保存。')
      return result.connector
    } catch (error) { setNotice(error instanceof Error ? error.message : String(error)); throw error }
    finally { setBusy('') }
  }

  const test = async () => {
    setBusy('test'); setNotice('')
    try {
      const saved = draft.id ? await save() : await save(draft)
      const result = await window.ranparty.request<{ ok: boolean; message: string; tools: ConnectorCatalogEntry[]; resources: ConnectorCatalogEntry[]; prompts: ConnectorCatalogEntry[] }>('connectors.test', { id: saved.id })
      setCatalog((current) => ({ ...current, tools: result.tools ?? [], resources: result.resources ?? [], prompts: result.prompts ?? [] }))
      setNotice(result.message)
    } catch (error) { setNotice(error instanceof Error ? error.message : String(error)) }
    finally { setBusy('') }
  }

  const toggleTool = (name: string, field: 'enabledTools' | 'pinnedTools') => {
    const values = new Set(draft[field] ?? [])
    values.has(name) ? values.delete(name) : values.add(name)
    setDraft({ ...draft, [field]: [...values] })
  }

  const canDiscardDraft = () => !dirty || window.confirm('当前连接器配置尚未保存，确定放弃修改吗？')

  const remove = async () => {
    if (!draft.id || !window.confirm(`删除连接器“${draft.name}”？`)) return
    setBusy('delete')
    try { await window.ranparty.request('connectors.delete', { id: draft.id }); setDraft(blankConnector()); setSelectedId(''); await reload('') }
    finally { setBusy('') }
  }

  const reconnect = async () => {
    if (!draft.id || !canDiscardDraft()) return
    setBusy('reconnect')
    try { await window.ranparty.request('connectors.reconnect', { id: draft.id }); await reload(draft.id); setNotice('连接器已重连。') }
    catch (error) { setNotice(error instanceof Error ? error.message : String(error)) }
    finally { setBusy('') }
  }

  const oauth = async () => {
    if (!draft.id || !canDiscardDraft()) return
    setBusy('oauth')
    try {
      if (draft.oauthAuthenticated) {
        await window.ranparty.request('connectors.oauth.logout', { id: draft.id })
        setNotice('OAuth 会话已退出。')
      } else {
        const result = await window.ranparty.request<{ authorizationUrl: string }>('connectors.oauth.start', { id: draft.id })
        await window.ranparty.pathAction('open', result.authorizationUrl)
        setNotice('已在系统浏览器中打开授权页面。')
      }
      await reload(draft.id)
    } catch (error) { setNotice(error instanceof Error ? error.message : String(error)) }
    finally { setBusy('') }
  }

  const selectConnector = (id: string) => {
    if (!canDiscardDraft()) return
    setSelectedId(id)
  }
  const addConnector = () => {
    if (!canDiscardDraft()) return
    setSelectedId('')
    setDraft(blankConnector())
    setEnvText('')
    setHeaderText('')
    setCatalog({ tools: [], resources: [], prompts: [], logs: [] })
  }

  const importConfig = async (file: File) => {
    if (!canDiscardDraft()) return
    setBusy('import')
    try {
      const content = await file.text()
      const format = file.name.toLowerCase().endsWith('.toml') ? 'codex' : 'claude'
      const preview = await window.ranparty.request<{ connectors: ConnectorConfig[] }>('connectors.import.preview', { format, content })
      if (!preview.connectors.length) throw new Error('没有发现 MCP 连接器配置。')
      if (!window.confirm(`发现 ${preview.connectors.length} 个连接器。导入后默认保持禁用，继续吗？`)) return
      await window.ranparty.request('connectors.import.apply', { connectors: preview.connectors })
      await reload()
      setNotice(`已导入 ${preview.connectors.length} 个连接器。`)
    } catch (error) { setNotice(error instanceof Error ? error.message : String(error)) }
    finally { setBusy('') }
  }

  return <section className="connector-settings">
    <div className="connector-heading"><div><h3>连接器</h3><p>管理 stdio 与 Streamable HTTP MCP。新发现的工具需要明确开放后才会提供给模型。</p></div><div className="connector-actions"><label className="outline-button connector-import"><FileUp size={15} />导入<input type="file" accept=".toml,.json" onChange={(event) => event.target.files?.[0] && void importConfig(event.target.files[0])} /></label><button className="outline-button" onClick={addConnector}><Plus size={15} />添加</button></div></div>
    <div className="connector-layout">
      <aside className="connector-list" aria-label="连接器列表">
        {connectors.map((item) => <button key={item.id} className={item.id === selectedId ? 'selected' : ''} onClick={() => selectConnector(item.id)}><span className={`connector-dot ${item.status ?? 'disconnected'}`} /><span><strong>{item.name}</strong><small>{item.type === 'stdio' ? 'stdio' : 'Streamable HTTP'} · {item.status ?? 'disconnected'}</small></span><em>{item.toolCount ?? 0}</em></button>)}
        {!connectors.length ? <div className="connector-empty"><Cable size={22} /><span>尚未配置连接器</span></div> : null}
      </aside>
      <div className="connector-editor">
        <div className="connector-form-grid">
          <label><span>名称</span><input value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} placeholder="例如 GitHub" /></label>
          <label><span>传输</span><select value={draft.type} onChange={(event) => setDraft({ ...draft, type: event.target.value as ConnectorConfig['type'] })}><option value="stdio">stdio</option><option value="streamable_http">Streamable HTTP</option></select></label>
          {draft.type === 'stdio' ? <><label className="wide"><span>命令</span><input value={draft.command ?? ''} onChange={(event) => setDraft({ ...draft, command: event.target.value })} placeholder="npx / uvx / 可执行文件" /></label><label className="wide"><span>参数</span><input value={(draft.args ?? []).join(' ')} onChange={(event) => setDraft({ ...draft, args: event.target.value.match(/(?:[^\s"]+|"[^"]*")+/g)?.map((value) => value.replace(/^"|"$/g, '')) ?? [] })} /></label><label className="wide"><span>工作目录</span><input value={draft.cwd ?? ''} onChange={(event) => setDraft({ ...draft, cwd: event.target.value })} /></label><label className="wide"><span>环境变量秘密</span><textarea rows={3} value={envText} onChange={(event) => setEnvText(event.target.value)} placeholder="API_KEY=value（保存后加密）" /></label></> : <><label className="wide"><span>URL</span><input value={draft.url ?? ''} onChange={(event) => setDraft({ ...draft, url: event.target.value })} placeholder="https://example.com/mcp" /></label><label><span>认证</span><select value={draft.auth ?? 'none'} onChange={(event) => setDraft({ ...draft, auth: event.target.value as ConnectorConfig['auth'] })}><option value="none">无</option><option value="bearer">Bearer</option><option value="oauth">OAuth 2.1</option></select></label><label className="wide"><span>HTTP Header 秘密</span><textarea rows={3} value={headerText} onChange={(event) => setHeaderText(event.target.value)} placeholder="Authorization=Bearer ...（保存后加密）" /></label></>}
          <label><span>默认审批</span><select value={draft.approvalMode ?? 'ask'} onChange={(event) => setDraft({ ...draft, approvalMode: event.target.value as ConnectorConfig['approvalMode'] })}><option value="ask">每次询问</option><option value="auto">自动允许</option><option value="deny">拒绝</option></select></label>
          <label><span>工具超时（秒）</span><input type="number" min={3} max={600} value={draft.toolTimeoutSeconds ?? 60} onChange={(event) => setDraft({ ...draft, toolTimeoutSeconds: Number(event.target.value) })} /></label>
        </div>
        <div className="connector-toggles"><label><input type="checkbox" checked={draft.enabled} onChange={(event) => setDraft({ ...draft, enabled: event.target.checked })} />启用连接器</label><label><input type="checkbox" checked={draft.supportsParallelToolCalls ?? false} onChange={(event) => setDraft({ ...draft, supportsParallelToolCalls: event.target.checked })} />允许并行工具调用</label><label title="默认限制 10 RPM、4096 tokens、30 秒且禁止工具轮次"><input type="checkbox" checked={draft.sampling?.enabled ?? false} onChange={(event) => setDraft({ ...draft, sampling: { ...(draft.sampling ?? { requestsPerMinute: 10, maxTokens: 4096, timeoutSeconds: 30, maxToolRounds: 0 }), enabled: event.target.checked } })} />允许 Sampling</label></div>
        <div className="connector-commandbar"><button className="primary-button" disabled={!!busy || !draft.name} onClick={() => void save()}>{busy === 'save' ? <Loader2 className="spin" size={15} /> : <Save size={15} />}保存</button><button className="outline-button" disabled={!!busy || !draft.name} onClick={() => void test()}><TestTube2 size={15} />测试与发现</button>{draft.id && draft.auth === 'oauth' ? <button className="outline-button" disabled={!!busy} onClick={() => void oauth()}>{draft.oauthAuthenticated ? '退出 OAuth' : 'OAuth 登录'}</button> : null}{draft.id ? <><button className="icon-button" title="重连" aria-label="重连" disabled={!!busy} onClick={() => void reconnect()}><RefreshCw size={16} /></button><button className="icon-button danger" title="删除" aria-label="删除" disabled={!!busy} onClick={() => void remove()}><Trash2 size={16} /></button></> : null}</div>
        {notice ? <div className="connector-notice" role="status">{notice.includes('成功') || notice.includes('已') ? <Check size={15} /> : <CircleAlert size={15} />}{notice}</div> : null}
        <div className="connector-tabs">{(['tools', 'resources', 'prompts', 'logs'] as CatalogTab[]).map((name) => <button key={name} className={tab === name ? 'selected' : ''} onClick={() => setTab(name)}>{({ tools: '工具', resources: '资源', prompts: '提示词', logs: '日志' })[name]}</button>)}</div>
        <div className="connector-catalog">
          {tab === 'tools' ? catalog.tools.map((tool) => <div className="connector-tool" key={tool.name}><label><input type="checkbox" checked={(draft.enabledTools ?? []).includes(tool.name)} onChange={() => toggleTool(tool.name, 'enabledTools')} /><span><strong>{tool.title || tool.name}</strong><small>{tool.description || tool.exposedName}</small></span></label><label className="pin-tool"><input type="checkbox" checked={(draft.pinnedTools ?? []).includes(tool.name)} disabled={!(draft.enabledTools ?? []).includes(tool.name)} onChange={() => toggleTool(tool.name, 'pinnedTools')} />常驻</label></div>) : catalog[tab].map((entry) => <div className="connector-capability" key={entry.name}><strong>{entry.title || entry.name}</strong><small>{entry.description}</small></div>)}
          {!catalog[tab].length ? <div className="connector-empty"><span>{tab === 'logs' ? '本次尚无日志' : '测试连接后显示发现的能力'}</span></div> : null}
        </div>
      </div>
    </div>
  </section>
}
