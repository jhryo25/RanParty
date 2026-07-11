import { ArrowDown, ArrowUp, Check, Eye, EyeOff, FilePlus2, FolderOpen, FolderPlus, Image, Plus, RefreshCw, Save, ShieldAlert, ShieldCheck, Sparkles, Star, TestTube2, Trash2, Wrench, X } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { Profile, Settings } from '../types'

import { KnowledgeManager } from './KnowledgeManager'

type Section = 'model' | 'character' | 'security' | 'context' | 'knowledge'
interface Character { name: string; displayName?: string; path: string; isSoul?: boolean }
interface CardSection { heading: string; body: string }

interface Props {
  settings: Settings
  onClose: () => void
  onSave: (payload: Record<string, unknown>) => Promise<void>
}

export function SettingsDrawer({ settings, onClose, onSave }: Props) {
  const [section, setSection] = useState<Section>('model')
  const [ioRoots, setIoRoots] = useState((settings.ioRoots ?? '').split('|').filter(Boolean).join('\n'))
  const [shellMode, setShellMode] = useState(settings.shellMode)
  const [contextWindow, setContextWindow] = useState(settings.contextWindow)
  const [compactThreshold, setCompactThreshold] = useState(settings.compactThreshold)
  const [saving, setSaving] = useState(false)
  const [localDirty, setLocalDirty] = useState(false)
  const [saveNotice, setSaveNotice] = useState('')

  // Sync from external settings changes when user hasn't modified fields
  useEffect(() => {
    if (!localDirty) {
      setIoRoots((settings.ioRoots ?? '').split('|').filter(Boolean).join('\n'))
      setShellMode(settings.shellMode)
      setContextWindow(settings.contextWindow)
      setCompactThreshold(settings.compactThreshold)
    }
  }, [settings.ioRoots, settings.shellMode, settings.contextWindow, settings.compactThreshold, localDirty])

  useEffect(() => {
    if (!saveNotice) return
    const timer = window.setTimeout(() => setSaveNotice(''), 2800)
    return () => window.clearTimeout(timer)
  }, [saveNotice])

  const markDirty = () => setLocalDirty(true)

  const saveGlobals = async () => {
    setSaving(true)
    try {
      await onSave({ ioRoots: ioRoots.split(/\r?\n/).map((item) => item.trim()).filter(Boolean).join('|'), shellMode, contextWindow, compactThreshold })
      setLocalDirty(false)
      setSaveNotice('设置已保存，重启后仍会生效')
    } catch (error) {
      setSaveNotice(`保存失败：${error instanceof Error ? error.message : String(error)}`)
    } finally { setSaving(false) }
  }

  const requestClose = () => {
    if (localDirty && !window.confirm('安全与上下文设置尚未保存，确定关闭吗？')) return
    onClose()
  }

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const key = event.key.toLowerCase()
      if ((event.ctrlKey || event.metaKey) && key === 's') {
        event.preventDefault()
        if ((section === 'security' || section === 'context') && localDirty && !saving) void saveGlobals()
      }
      if (event.key === 'Escape') {
        event.preventDefault()
        requestClose()
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [section, localDirty, saving, ioRoots, shellMode, contextWindow, compactThreshold])

  return <div className="drawer-layer" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && requestClose()}>
    <aside className="settings-drawer" role="dialog" aria-modal="true" aria-label="设置">
      <header className="drawer-header"><h2>设置</h2><button className="icon-button" onClick={requestClose}><X size={22} /></button></header>
      <div className="settings-body">
        <nav className="settings-nav"><NavButton active={section === 'model'} onClick={() => setSection('model')}>模型配置</NavButton><NavButton active={section === 'character'} onClick={() => setSection('character')}>角色卡</NavButton><NavButton active={section === 'security'} onClick={() => setSection('security')}>安全与工具</NavButton><NavButton active={section === 'context'} onClick={() => setSection('context')}>上下文</NavButton><NavButton active={section === 'knowledge'} onClick={() => setSection('knowledge')}>知识管理</NavButton></nav>
        <div className="settings-panel">
          {localDirty ? <div className="settings-dirty-banner" role="status"><ShieldAlert size={15} /><span>有未保存修改。按 Ctrl + S 保存，或在关闭前确认放弃。</span></div> : null}
          {section === 'model' ? <ModelProfiles settings={settings} /> : null}
          {section === 'character' ? <CharacterEditor /> : null}
          {section === 'security' ? <SecuritySettings roots={ioRoots.split(/\r?\n/).filter(Boolean)} onRootsChange={(roots) => { setIoRoots(roots.join('\n')); markDirty() }} shellMode={shellMode} onShellModeChange={(mode) => { setShellMode(mode); markDirty() }} /> : null}
          {section === 'context' ? <ContextSettings contextWindow={contextWindow} onContextWindowChange={(v) => { setContextWindow(v); markDirty() }} compactThreshold={compactThreshold} onCompactThresholdChange={(v) => { setCompactThreshold(v); markDirty() }} /> : null}
          {section === 'knowledge' ? <KnowledgeManager /> : null}
        </div>
      </div>
      <footer className="drawer-footer">{saveNotice ? <div className={saveNotice.startsWith('保存失败') ? 'settings-save-toast failed' : 'settings-save-toast'} role="status"><Check size={15} />{saveNotice}</div> : localDirty ? <div className="settings-save-toast pending" role="status"><ShieldAlert size={15} />有未保存修改</div> : null}<button className="outline-button" onClick={requestClose}>关闭</button>{section === 'security' || section === 'context' ? <button className="primary-button" onClick={() => void saveGlobals()} disabled={saving || !localDirty}><Save size={16} />{saving ? '保存中…' : localDirty ? '保存设置' : '已保存'}</button> : null}</footer>
    </aside>
  </div>
}

function ContextSettings({ contextWindow, onContextWindowChange, compactThreshold, onCompactThresholdChange }: { contextWindow: number; onContextWindowChange: (value: number) => void; compactThreshold: number; onCompactThresholdChange: (value: number) => void }) {
  const windows = [32000, 64000, 128000, 200000, 256000, 400000, 1000000]
  const thresholds = [70, 80, 85, 90]
  return <section>
    <PanelTitle title="上下文" copy="配置全局兜底容量，以及达到多少占用时自动总结历史对话。模型配置中的上下文上限优先。" />
    <div className="context-settings-card">
      <div className="context-setting-head"><div><strong>全局上下文窗口</strong><span>单位：Token</span></div><small>不确定模型上限时建议 128K；必须以服务商文档为准。</small></div>
      <div className="unit-input"><input aria-label="全局上下文窗口" type="number" min={1000} step={1000} value={contextWindow} onChange={(event) => onContextWindowChange(Number(event.target.value))} /><span>Token</span></div>
      <div className="preset-row">{windows.map((value) => <button key={value} className={contextWindow === value ? 'selected' : ''} onClick={() => onContextWindowChange(value)}>{formatLimit(value)}{value === 128000 ? <em>推荐</em> : null}</button>)}</div>
      <p>常用模板：32K 适合短问答，64K 适合普通项目，128K 适合多数长任务；200K–400K 与 1M 仅在模型官方明确支持时使用。</p>
    </div>
    <div className="context-settings-card">
      <div className="context-setting-head"><div><strong>自动总结阈值</strong><span>单位：上下文占用百分比</span></div><small>建议 80%，为下一轮回复和工具结果预留空间。</small></div>
      <div className="unit-input"><input aria-label="自动总结阈值" type="number" min={10} max={95} value={compactThreshold} onChange={(event) => onCompactThresholdChange(Number(event.target.value))} /><span>%</span></div>
      <div className="preset-row">{thresholds.map((value) => <button key={value} className={compactThreshold === value ? 'selected' : ''} onClick={() => onCompactThresholdChange(value)}>{value}%{value === 80 ? <em>推荐</em> : null}</button>)}</div>
      <div className="auto-compact-note"><Sparkles size={16} /><span>达到阈值后，RanParty 会在下一次发送前自动生成结构化摘要，并在聊天中显示压缩前后 Token。完整聊天记录仍然保留。</span></div>
    </div>
  </section>
}

function SecuritySettings({ roots, onRootsChange, shellMode, onShellModeChange }: {
  roots: string[]
  onRootsChange: (roots: string[]) => void
  shellMode: 'ask' | 'auto'
  onShellModeChange: (mode: 'ask' | 'auto') => void
}) {
  const addRoot = async () => {
    const path = await window.ranparty.chooseDirectory()
    if (path && !roots.includes(path)) onRootsChange([...roots, path])
  }
  return <section>
    <PanelTitle title="安全与工具" copy="决定 AI 能访问哪些目录，以及执行命令前是否需要你的确认。" />
    <div className="security-explainer"><ShieldCheck size={20} /><div><strong>当前会话工作区会自动授权</strong><p>下面只需添加工作区之外、希望 AI 长期读取或写入的目录。RanParty 自身框架目录无需重复添加。</p></div></div>
    <div className="security-block">
      <div className="security-block-title"><div><h4>额外授权目录</h4><p>目录及其子目录将允许文件工具访问。</p></div><button className="outline-button" onClick={() => void addRoot()}><FolderPlus size={15} />添加目录</button></div>
      <div className="security-root-list">
        {roots.map((root) => <div className="security-root" key={root}><FolderOpen size={17} /><span title={root}>{root}</span><button onClick={() => onRootsChange(roots.filter((item) => item !== root))} aria-label={`移除 ${root}`}><X size={14} /></button></div>)}
        {roots.length === 0 ? <div className="security-empty">没有额外目录；AI 仍可访问当前会话工作区。</div> : null}
      </div>
    </div>
    <div className="security-block">
      <div className="security-block-title"><div><h4>命令执行审批</h4><p>影响 Shell、PowerShell 等本地命令。</p></div></div>
      <div className="approval-mode-grid">
        <button className={shellMode === 'ask' ? 'selected' : ''} onClick={() => onShellModeChange('ask')}><ShieldCheck size={21} /><span><strong>每步确认</strong><small>每次危险命令都先展示内容，由你决定是否执行。推荐日常使用。</small></span></button>
        <button className={shellMode === 'auto' ? 'selected risky' : 'risky'} onClick={() => onShellModeChange('auto')}><ShieldAlert size={21} /><span><strong>自动通过</strong><small>命令无需确认即可执行，仅适合可信工作区和短时调试。</small></span></button>
      </div>
      {shellMode === 'auto' ? <div className="security-warning"><ShieldAlert size={16} />自动通过会显著提高误删文件或执行意外命令的风险。</div> : null}
    </div>
  </section>
}

function ModelProfiles({ settings }: { settings: Settings }) {
  const [selectedName, setSelectedName] = useState(settings.activeProfileName || settings.profiles[0]?.name || '')
  const selected = settings.profiles.find((profile) => profile.name === selectedName)
  const [draft, setDraft] = useState<Profile & { apiKey: string }>(() => editableProfile(selected))
  const [originalName, setOriginalName] = useState(selected?.name ?? '')
  const [showKey, setShowKey] = useState(false)
  const [characters, setCharacters] = useState<Character[]>([])
  const [status, setStatus] = useState('')
  const [testing, setTesting] = useState(false)
  const [availableModels, setAvailableModels] = useState<string[]>([])
  const [loadingModels, setLoadingModels] = useState(false)
  const [draftDirty, setDraftDirty] = useState(false)

  useEffect(() => { window.ranparty.request<{ characters: Character[] }>('characters.list').then((result) => setCharacters(result.characters)).catch((error) => setStatus(String(error))) }, [])
  useEffect(() => {
    if (draftDirty) return
    const profile = settings.profiles.find((item) => item.name === selectedName) ?? settings.profiles[0]
    if (profile) { setDraft(editableProfile(profile)); setOriginalName(profile.name) }
  }, [selectedName, settings.profiles, draftDirty])

  const select = (profile: Profile) => { setSelectedName(profile.name); setStatus(''); setDraftDirty(false) }
  const create = () => { setSelectedName(''); setOriginalName(''); setDraft({ name: uniqueName(settings.profiles), baseUrl: 'https://api.openai.com/v1', model: '', characterCard: '', characterDisplayName: 'SOUL', provider: 'openai', wireProtocol: 'responses', supportsTools: true, supportsImages: true, supportsReasoning: true, contextWindow: 200000, maxOutputTokens: 8192, apiKeyConfigured: false, apiKey: '' }); setStatus('新配置尚未保存'); setDraftDirty(true) }
  const save = async () => {
    if (!draft.name.trim() || !draft.baseUrl.trim() || !draft.model.trim()) { setStatus('请完整填写名称、API 地址和模型'); return }
    try {
      const saved = await window.ranparty.request<Settings>('profiles.save', { originalName, profile: draft })
      setSelectedName(draft.name); setOriginalName(draft.name); setDraft((value) => ({ ...value, apiKey: '', apiKeyConfigured: value.apiKeyConfigured || Boolean(value.apiKey) })); setStatus('已保存，重启客户端后仍会生效'); setDraftDirty(false)
      if (!saved?.profiles?.some((profile) => profile.name === draft.name)) setStatus('配置已保存，但前端尚未收到最新配置列表，请关闭设置后重新打开')
    } catch (error) { setStatus(String(error)) }
  }
  const setActive = async () => { await window.ranparty.request('profiles.setActive', { name: draft.name }); setStatus('已设为新会话默认配置') }
  const remove = async () => {
    if (!originalName || !window.confirm(`确定删除模型配置“${originalName}”吗？`)) return
    try { await window.ranparty.request('profiles.delete', { name: originalName }); setSelectedName(settings.profiles.find((item) => item.name !== originalName)?.name ?? ''); setStatus('已删除') } catch (error) { setStatus(String(error)) }
  }
  const test = async () => {
    if (!draft.baseUrl.trim() || !draft.model.trim()) { setStatus('请先填写 API 地址和模型名称'); return }
    setTesting(true); setStatus('正在发起真实模型请求…')
    try {
      const result = await window.ranparty.request<{ latencyMs?: number; reply?: string; protocol?: string }>('profiles.test', { originalName, profile: draft })
      if (!result || typeof result !== 'object') throw new Error('后端未返回测试结果，请检查后端是否仍在运行')
      const protocol = result.protocol || protocolName(draft)
      const latency = Number.isFinite(result.latencyMs) ? `${result.latencyMs} ms` : '未返回耗时'
      const reply = result.reply?.trim() || 'OK'
      setStatus(`连接成功 · ${protocol} · ${latency} · ${reply}`)
    } catch (error) { setStatus(String(error)) }
    finally { setTesting(false) }
  }
  const loadModels = async () => { setLoadingModels(true); setStatus('正在从服务商获取模型列表…'); try { const result = await window.ranparty.request<{ models: string[]; endpoint?: string }>('profiles.models', { originalName, profile: draft }); setAvailableModels(result.models); setStatus(result.models.length ? `已获取 ${result.models.length} 个模型，可从下方列表选择` : '服务商返回了空模型列表；仍可手动填写模型名称') } catch (error) { setStatus(`获取模型失败：${error instanceof Error ? error.message : String(error)}。部分兼容服务不开放模型列表，可继续手动填写。`) } finally { setLoadingModels(false) } }
  const setProvider = (provider: 'openai' | 'anthropic') => { setDraftDirty(true); setDraft((value) => ({
    ...value,
    provider,
    wireProtocol: provider === 'anthropic' ? 'anthropic_messages' : value.wireProtocol === 'anthropic_messages' ? 'responses' : value.wireProtocol,
    baseUrl: provider === 'anthropic' && value.baseUrl === 'https://api.openai.com/v1' ? 'https://api.anthropic.com/v1' : provider === 'openai' && value.baseUrl === 'https://api.anthropic.com/v1' ? 'https://api.openai.com/v1' : value.baseUrl,
  })) }
  const endpoint = previewEndpoint(draft)
  const updateDraft = (patch: Partial<Profile & { apiKey: string }>) => {
    setDraftDirty(true)
    setDraft((value) => {
      const next = { ...value, ...patch }
      next.wireProtocol = compatibleWireProtocol(next.baseUrl, next.wireProtocol)
      return next
    })
  }

  return <section><PanelTitle title="模型配置" copy="分别适配 OpenAI 与 Anthropic 线协议；保存前可发起一次真实请求验证地址、密钥和模型。" action={<button className="outline-button" onClick={create}><Plus size={15} />新配置</button>} />
    <div className="profile-layout"><div className="profile-list">{!originalName ? <button className="active draft-profile-card"><span><strong>{draft.name || '新配置'}</strong><em>未保存</em></span><small>{draft.provider === 'anthropic' ? 'Anthropic 兼容' : 'OpenAI 兼容'} · {draft.model || '尚未选择模型'}</small><small>{draft.baseUrl}</small><i>填写完成后保存</i></button> : null}{settings.profiles.map((profile) => <button key={profile.name} className={profile.name === originalName ? 'active' : ''} onClick={() => select(profile)}><span><strong>{profile.name}</strong>{profile.name === settings.activeProfileName ? <em><Star size={11} />默认</em> : null}</span><small>{profile.provider === 'anthropic' ? 'Anthropic 兼容' : 'OpenAI 兼容'} · {profile.model}</small><small>{profile.baseUrl}</small><small>角色：{profile.characterDisplayName || 'SOUL'}</small><i className={profile.apiKeyConfigured ? 'configured' : ''}>{profile.apiKeyConfigured ? '密钥已配置' : '未配置密钥'}</i></button>)}</div>
      <div className="profile-editor">
        <Field label="配置名称"><input value={draft.name} onChange={(event) => updateDraft({ name: event.target.value })} /></Field>
        <Field label="兼容类型"><div className="provider-switch"><button className={draft.provider === 'openai' ? 'selected' : ''} onClick={() => setProvider('openai')}>OpenAI 兼容</button><button className={draft.provider === 'anthropic' ? 'selected' : ''} onClick={() => setProvider('anthropic')}>Anthropic 兼容</button></div></Field>
        {draft.provider === 'openai' ? <Field label="请求协议" hint="Responses 是 Codex 当前使用的协议；旧服务可选择 Chat Completions。"><select value={draft.wireProtocol} onChange={(event) => updateDraft({ wireProtocol: event.target.value as Profile['wireProtocol'] })}><option value="responses">Responses API（Codex 风格）</option><option value="chat_completions">Chat Completions</option></select></Field> : <div className="protocol-note">使用 Anthropic Messages API，并自动转换系统提示、图片和工具调用格式。</div>}
        <Field label="API 地址" hint={`实际请求：${endpoint}`}><input value={draft.baseUrl} onChange={(event) => updateDraft({ baseUrl: event.target.value })} /></Field>
        <Field label="API 密钥"><div className="password-field"><input type={showKey ? 'text' : 'password'} value={draft.apiKey} placeholder={draft.apiKeyConfigured ? '已配置，留空表示不修改' : '输入 API 密钥'} onChange={(event) => updateDraft({ apiKey: event.target.value })} /><button onClick={() => setShowKey((value) => !value)}>{showKey ? <EyeOff size={17} /> : <Eye size={17} />}</button></div></Field>
        <Field label="模型名称"><div className="model-picker"><input list="provider-models" value={draft.model} placeholder={draft.provider === 'anthropic' ? '例如 claude-sonnet-4-5' : '例如 gpt-5.2-codex'} onChange={(event) => updateDraft({ model: event.target.value })} /><datalist id="provider-models">{availableModels.map(model => <option key={model} value={model} />)}</datalist><button className="outline-button" disabled={loadingModels} onClick={() => void loadModels()}><RefreshCw className={loadingModels ? 'spin' : ''} size={14} />获取模型</button></div>{availableModels.length ? <div className="model-results" role="listbox" aria-label="模型列表">{availableModels.map(model => <button type="button" className={draft.model === model ? 'selected' : ''} key={model} onClick={() => updateDraft({ model })}>{model}</button>)}</div> : null}</Field>
        <Field label="角色卡"><select value={draft.characterCard} onChange={(event) => updateDraft({ characterCard: event.target.value })}><option value="">{characterLabel(characters.find((character) => character.isSoul))}（SOUL.md）</option>{characters.filter((character) => !character.isSoul).map((character) => <option key={character.name} value={character.name}>{characterLabel(character)}（{character.name}.md）</option>)}</select></Field>
        <div className="model-advanced"><div className="advanced-heading"><strong>高级配置</strong><span>这些开关决定 RanParty 会不会向模型发送对应内容。</span></div><div className="capability-grid">
          <Capability checked={draft.supportsTools} onChange={(checked) => updateDraft({ supportsTools: checked })} icon={<Wrench size={16} />} title="工具调用" copy="允许模型读写文件、执行命令" />
          <Capability checked={draft.supportsImages} onChange={(checked) => updateDraft({ supportsImages: checked })} icon={<Image size={16} />} title="图片输入" copy="允许发送粘贴或附加的图片" />
          <Capability checked={draft.supportsReasoning} onChange={(checked) => updateDraft({ supportsReasoning: checked })} icon={<Sparkles size={16} />} title="思考模式" copy="解析并显示模型推理摘要" />
        </div><div className="token-limit-grid"><TokenChoice label="输入 / 上下文上限" value={draft.contextWindow} options={[32000, 64000, 128000, 256000, 400000, 1000000]} recommended={128000} hint="单位为 Token。建议填写模型官方上下文窗口；1M 仅适用于明确支持百万上下文的模型。" onChange={value => updateDraft({ contextWindow: value })} /><TokenChoice label="最大输出长度" value={draft.maxOutputTokens} options={[4000, 8000, 16000, 32000, 64000]} recommended={8000} hint="单位为 Token。建议 8K；长报告可选 16K 或 32K，但不能超过服务商限制。" onChange={value => updateDraft({ maxOutputTokens: value })} /></div><p className="token-save-note">这些值随模型配置保存，重启客户端后继续生效；“服务商默认”表示不向接口发送限制参数。</p></div>
        <div className="profile-actions"><span className={status.includes('失败') || status.startsWith('Error') ? 'failed' : ''}>{status || (draftDirty ? '有未保存配置修改' : '')}</span><button className="outline-button test-button" disabled={testing} onClick={() => void test()}><TestTube2 size={14} />{testing ? '测试中…' : '测试连接'}</button><button className="outline-button" disabled={!originalName || draft.name === settings.activeProfileName} onClick={() => void setActive()}><Star size={14} />设为默认</button><button className="outline-button danger" disabled={!originalName || settings.profiles.length <= 1} onClick={() => void remove()}><Trash2 size={14} />删除</button><button className="primary-button" onClick={() => void save()}><Save size={14} />保存配置</button></div>
      </div>
    </div>
  </section>
}

function Capability({ checked, onChange, icon, title, copy }: { checked: boolean; onChange: (checked: boolean) => void; icon: React.ReactNode; title: string; copy: string }) {
  return <label className={checked ? 'capability selected' : 'capability'}><input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} /><span className="capability-icon">{icon}</span><span><strong>{title}</strong><small>{copy}</small></span></label>
}

function TokenChoice({ label, value, options, recommended, hint, onChange }: { label: string; value: number; options: number[]; recommended: number; hint: string; onChange: (value: number) => void }) {
  return <div className="token-choice"><label>{label}<span>Token</span></label><input type="number" min={0} step={1000} value={value || ''} placeholder="使用服务商默认值" onChange={event => onChange(Math.max(0, Number(event.target.value)))} /><small>{hint}</small><div><button type="button" className={value === 0 ? 'selected' : ''} onClick={() => onChange(0)}>服务商默认</button>{options.map(option => <button type="button" className={value === option ? 'selected' : ''} key={option} onClick={() => onChange(option)}>{option >= 1000 ? `${option / 1000}K` : option}{option === recommended ? ' · 推荐' : ''}</button>)}</div></div>
}

function formatLimit(value: number) { return value >= 1000 ? `${value / 1000}K` : String(value) }

function CharacterEditor() {
  const [characters, setCharacters] = useState<Character[]>([])
  const [originalName, setOriginalName] = useState('')
  const [name, setName] = useState('')
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [sections, setSections] = useState<CardSection[]>(starterSections())
  const [raw, setRaw] = useState('')
  const [rawMode, setRawMode] = useState(false)
  const [preview, setPreview] = useState(false)
  const [dirty, setDirty] = useState(false)
  const [status, setStatus] = useState('')
  const content = rawMode ? raw : buildMarkdown(title, description, sections)
  const isSoul = originalName === 'SOUL'

  const refresh = async () => { const result = await window.ranparty.request<{ characters: Character[] }>('characters.list'); setCharacters(result.characters) }
  useEffect(() => { void refresh() }, [])
  const load = async (next: string) => {
    if (!next) return
    if (dirty && !window.confirm('当前角色卡尚未保存，确定放弃修改吗？')) return
    const result = await window.ranparty.request<{ name: string; content: string; isSoul?: boolean }>('characters.read', { name: next })
    const parsed = parseMarkdown(result.content)
    setOriginalName(result.name); setName(result.name); setTitle(parsed.title); setDescription(parsed.description); setSections(parsed.sections); setRaw(result.content); setDirty(false); setStatus('')
  }
  const create = () => {
    if (dirty && !window.confirm('当前角色卡尚未保存，确定新建吗？')) return
    setOriginalName(''); setName('new-character'); setTitle('新角色'); setDescription('描述这个角色的定位与协作方式。'); setSections(starterSections()); setRaw(''); setRawMode(false); setDirty(true); setStatus('新模板尚未保存')
  }
  const save = async () => {
    if (!name.trim()) { setStatus('请填写角色卡文件名'); return }
    try {
      if (originalName && originalName !== name) await window.ranparty.request('characters.rename', { oldName: originalName, newName: name })
      await window.ranparty.request('characters.save', { name, content })
      setOriginalName(name); setRaw(content); setDirty(false); setStatus('已保存'); await refresh()
    } catch (error) { setStatus(String(error)) }
  }
  const remove = async () => {
    if (!originalName || !window.confirm(`确定删除角色卡“${originalName}”吗？`)) return
    await window.ranparty.request('characters.delete', { name: originalName }); setOriginalName(''); setName(''); setTitle(''); setDescription(''); setSections(starterSections()); setRaw(''); setDirty(false); setStatus('已删除'); await refresh()
  }
  const toggleRaw = () => {
    if (rawMode) { const parsed = parseMarkdown(raw); setTitle(parsed.title); setDescription(parsed.description); setSections(parsed.sections) }
    else setRaw(buildMarkdown(title, description, sections))
    setRawMode((value) => !value)
  }
  const updateSection = (index: number, patch: Partial<CardSection>) => { setSections((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, ...patch } : item)); setDirty(true) }
  const move = (index: number, delta: number) => setSections((current) => { const next = [...current]; const target = index + delta; if (target < 0 || target >= next.length) return current; [next[index], next[target]] = [next[target], next[index]]; return next })

  return <section><PanelTitle title="角色卡" copy="每个模型配置只注入一个角色：未绑定模板时使用 SOUL.md，绑定后由该角色卡替代 SOUL.md。" action={<button className="outline-button" onClick={create}><FilePlus2 size={15} />新建模板</button>} />
    <div className="character-injection-note"><ShieldCheck size={17} /><span><strong>互斥注入</strong> SOUL.md 与其他角色卡不会叠加；AGENTS.md、TOOL.md、HUB.md 仍作为运行规则加载。</span></div>
    <div className="character-toolbar"><select value={originalName} onChange={(event) => void load(event.target.value)}><option value="">选择角色卡…</option>{characters.map((character) => <option key={character.name} value={character.name}>{characterLabel(character)}（{character.isSoul ? 'SOUL.md' : `${character.name}.md`}）</option>)}</select><button className="outline-button" onClick={toggleRaw}>{rawMode ? '结构化模式' : '源码模式'}</button><button className="outline-button" onClick={() => setPreview((value) => !value)}>{preview ? '关闭预览' : '预览'}</button></div>
    {preview ? <div className="character-preview"><ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown></div> : rawMode ? <textarea className="character-raw" rows={22} value={raw} onChange={(event) => { setRaw(event.target.value); setDirty(true) }} /> : <div className="character-structured"><Field label="文件名" hint={isSoul ? 'SOUL.md 是固定的默认角色文件' : '字母、数字、-、_'}><input value={name} disabled={isSoul} onChange={(event) => { setName(event.target.value); setDirty(true) }} /></Field><Field label="角色名称"><input value={title} onChange={(event) => { setTitle(event.target.value); setDirty(true) }} /></Field><Field label="简介"><input value={description} onChange={(event) => { setDescription(event.target.value); setDirty(true) }} /></Field>{sections.map((cardSection, index) => <div className="card-section-editor" key={`${index}-${cardSection.heading}`}><div><input value={cardSection.heading} onChange={(event) => updateSection(index, { heading: event.target.value })} /><span><button onClick={() => move(index, -1)} disabled={index === 0}><ArrowUp size={14} /></button><button onClick={() => move(index, 1)} disabled={index === sections.length - 1}><ArrowDown size={14} /></button><button className="danger" onClick={() => { setSections((current) => current.filter((_, itemIndex) => itemIndex !== index)); setDirty(true) }}><X size={14} /></button></span></div><textarea rows={4} value={cardSection.body} onChange={(event) => updateSection(index, { body: event.target.value })} /></div>)}<button className="outline-button add-section" onClick={() => { setSections((current) => [...current, { heading: '新章节', body: '' }]); setDirty(true) }}><Plus size={14} />添加章节</button></div>}
    <div className="character-actions"><span>{status}{dirty ? ' · 有未保存修改' : ''}</span><button className="outline-button danger" disabled={!originalName || isSoul} onClick={() => void remove()}><Trash2 size={14} />删除</button><button className="primary-button" onClick={() => void save()}><Save size={14} />{isSoul ? '保存 SOUL.md' : '保存角色卡'}</button></div>
  </section>
}

function starterSections(): CardSection[] { return [{ heading: '身份', body: '你是谁，以及你擅长帮助用户完成什么。' }, { heading: '性格', body: '描述稳定的性格特征与判断偏好。' }, { heading: '语气', body: '描述表达方式、详略程度与措辞风格。' }, { heading: '行为模式', body: '说明接到任务后的工作流程和协作方式。' }, { heading: '边界', body: '说明必须遵守的限制、确认条件与禁区。' }] }
function buildMarkdown(title: string, description: string, sections: CardSection[]) { return `# ${title.trim() || '未命名角色'}\n\n${description.trim() ? `> ${description.trim()}\n\n` : ''}${sections.map((section) => `## ${section.heading.trim() || '未命名章节'}\n\n${section.body.trim()}\n`).join('\n')}`.trim() + '\n' }
function parseMarkdown(content: string) {
  const title = content.match(/^#\s+(.+)$/m)?.[1]?.trim() ?? ''
  const description = content.match(/^>\s*(.+)$/m)?.[1]?.trim() ?? ''
  const sections = content.split(/^##\s+/m).slice(1).map((chunk) => {
    const newline = chunk.search(/\r?\n/)
    return newline < 0
      ? { heading: chunk.trim(), body: '' }
      : { heading: chunk.slice(0, newline).trim(), body: chunk.slice(newline).trim() }
  })
  return { title, description, sections: sections.length ? sections : starterSections() }
}
function editableProfile(profile?: Profile): Profile & { apiKey: string } { return {
  name: profile?.name ?? '', baseUrl: profile?.baseUrl ?? '', model: profile?.model ?? '', characterCard: profile?.characterCard ?? '', characterDisplayName: profile?.characterDisplayName ?? 'SOUL',
  provider: profile?.provider ?? 'openai', wireProtocol: profile?.wireProtocol ?? 'chat_completions', supportsTools: profile?.supportsTools ?? true, supportsImages: profile?.supportsImages ?? true,
  supportsReasoning: profile?.supportsReasoning ?? true, contextWindow: profile?.contextWindow ?? 200000, maxOutputTokens: profile?.maxOutputTokens ?? 8192,
  apiKeyConfigured: profile?.apiKeyConfigured ?? false, apiKey: '',
} }
function characterLabel(character?: Character) { return character?.displayName?.trim() || character?.name || 'SOUL' }
function previewEndpoint(profile: Profile) {
  const base = profile.baseUrl.replace(/\/$/, '')
  const suffix = profile.provider === 'anthropic' ? 'messages' : profile.wireProtocol === 'responses' ? 'responses' : 'chat/completions'
  return base.endsWith(`/${suffix}`) || base.endsWith(`/${suffix.split('/').at(-1)}`) ? base : `${base}/${suffix}`
}
function compatibleWireProtocol(baseUrl: string, wireProtocol: Profile['wireProtocol']) {
  try { const url = new URL(baseUrl); if (url.hostname.toLocaleLowerCase() === 'api.kimi.com' && url.pathname.replace(/\/$/, '') === '/coding/v1') return 'chat_completions' }
  catch { /* backend validation will report malformed URLs */ }
  return wireProtocol
}
function protocolName(profile: Profile) {
  if (profile.provider === 'anthropic') return 'Anthropic Messages'
  return profile.wireProtocol === 'responses' ? 'OpenAI Responses' : 'OpenAI Chat Completions'
}
function uniqueName(profiles: Profile[]) { let index = 1; let name = '新配置'; while (profiles.some((profile) => profile.name === name)) name = `新配置-${++index}`; return name }
function PanelTitle({ title, copy, action }: { title: string; copy: string; action?: React.ReactNode }) { return <div className="panel-title"><div><h3>{title}</h3><p>{copy}</p></div>{action}</div> }
function NavButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) { return <button className={active ? 'active' : ''} onClick={onClick}>{children}</button> }
function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) { return <label className="field"><span className="field-label">{label}</span>{children}{hint ? <small>{hint}</small> : null}</label> }
