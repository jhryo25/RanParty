import { Boxes, Cable, Check, Download, FolderTree, Globe2, KeyRound, PackageOpen, RefreshCw, Search, ShieldCheck, Sparkles, Star, TerminalSquare, UsersRound, Wrench, X } from 'lucide-react'
import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react'
import type { MarketplaceSkill } from '../types'
import { SkillDetailDialog } from './SkillDetailDialog'

type Section = 'featured' | 'hot' | 'newest' | 'trending' | 'installed'
type MarketView = 'skills' | 'experts' | 'connectors'
type SortBy = 'platform' | 'downloads' | 'stars' | 'name'
type SkillInstallPreview = { id: string; slug: string; name: string; description?: string; version?: string; trust: string; invocationPolicy: string; fileCount: number; totalBytes: number; allowedTools: string[]; scriptFiles: string[]; scriptFileCount: number; scriptFilesTruncated: boolean; contentPreview?: string; archiveSha256: string; confirmationToken: string; confirmationExpiresAt: string }
type PendingInstall = { item: MarketplaceSkill; slug: string; preview: SkillInstallPreview }
type ExpertPack = { id: string; slug: string; name: string; displayName?: string; description: string; summary?: string; avatarUrl?: string; scene?: string; skillCount: number; skillSlugs: string[]; source: string; content?: string }

const sectionMeta: Record<Section, { label: string; description: string }> = {
  featured: { label: '精选', description: 'SkillHub 编辑精选与质量推荐，不按单一数值排序' },
  hot: { label: '下载热榜', description: '按累计下载热度展示最常用的 Skill' },
  newest: { label: '最近上新', description: '按发布时间从新到旧展示' },
  trending: { label: '近期飙升', description: '按近期下载增长趋势展示，而非累计下载量' },
  installed: { label: '我安装的', description: '仅展示已经安装到 RanParty 的 Skill' },
}

export function SkillMarketplace({ onClose, workspace = '' }: { onClose: () => void; workspace?: string }) {
  const [view, setView] = useState<MarketView>('skills')
  const [items, setItems] = useState<MarketplaceSkill[]>([])
  const [section, setSection] = useState<Section>('featured')
  const [query, setQuery] = useState('')
  const deferredQuery = useDeferredValue(query)
  const [submittedQuery, setSubmittedQuery] = useState('')
  const [category, setCategory] = useState('all')
  const [apiKeyFilter, setApiKeyFilter] = useState<'all' | 'required' | 'none'>('all')
  const [sortBy, setSortBy] = useState<SortBy>('platform')
  const [loading, setLoading] = useState(true)
  const [workingIds, setWorkingIds] = useState<Set<string>>(() => new Set())
  const [pendingInstall, setPendingInstall] = useState<PendingInstall | null>(null)
  const [detailItem, setDetailItem] = useState<MarketplaceSkill | null>(null)
  const [status, setStatus] = useState('')
  const loadEpochRef = useRef(0)
  const workingIdsRef = useRef(new Set<string>())

  const load = useCallback(async (nextSection = section, nextQuery = submittedQuery) => {
    const epoch = ++loadEpochRef.current
    setLoading(true); setStatus('')
    try {
      const result = await window.ranparty.request<{ items: MarketplaceSkill[] }>('skills.skillhub.list', { section: nextSection, query: nextQuery, workspace })
      if (epoch !== loadEpochRef.current) return
      setItems(result.items)
      if (!result.items.length) setStatus(nextQuery ? `没有找到“${safeText(nextQuery)}”相关 Skill` : '当前分类暂无 Skill')
    } catch (error) {
      if (epoch === loadEpochRef.current) setStatus(`SkillHub 暂时不可用：${safeError(error)}`)
    } finally {
      if (epoch === loadEpochRef.current) setLoading(false)
    }
  }, [section, submittedQuery, workspace])

  useEffect(() => {
    if (view === 'skills') void load(section, submittedQuery)
    else { loadEpochRef.current++; setLoading(false) }
    return () => { loadEpochRef.current++ }
  }, [section, submittedQuery, workspace, view, load])

  const beginWorking = (id: string) => {
    if (workingIdsRef.current.has(id)) return false
    workingIdsRef.current.add(id)
    setWorkingIds(new Set(workingIdsRef.current))
    return true
  }

  const endWorking = (id: string) => {
    workingIdsRef.current.delete(id)
    setWorkingIds(new Set(workingIdsRef.current))
  }

  const toggle = async (item: MarketplaceSkill) => {
    if (!beginWorking(item.id)) return
    loadEpochRef.current++
    setLoading(false)
    setStatus('')
    try {
      if (item.installed) {
        await window.ranparty.request('skills.skillhub.uninstall', { id: item.id })
        setItems(current => current.map(candidate => candidate.id === item.id ? { ...candidate, installed: false } : candidate))
        setStatus(`已卸载 ${safeText(item.name)}`)
      }
      else {
        const slug = validateSlug(item.slug || item.id.replace(/^skillhub:/, ''))
        const preview = await window.ranparty.request<SkillInstallPreview>('skills.skillhub.preview', { slug, version: item.version, publisher: item.publisher })
        validatePreview(preview, slug)
        setPendingInstall({ item, slug, preview })
      }
    } catch (error) { setStatus(safeError(error)) }
    finally { endWorking(item.id) }
  }

  const confirmInstall = async () => {
    const pending = pendingInstall
    if (!pending || !beginWorking(pending.item.id)) return
    setPendingInstall(null)
    setStatus('')
    try {
      await window.ranparty.request('skills.skillhub.install', {
        slug: pending.slug,
        confirmed: true,
        confirmationToken: pending.preview.confirmationToken,
        archiveSha256: pending.preview.archiveSha256,
      })
      setItems(current => current.map(candidate => candidate.id === pending.item.id ? { ...candidate, installed: true } : candidate))
      setStatus(`已安装 ${safeText(pending.item.name)}；社区 Skill 仅能显式调用，工具能力继续受策略与审批限制`)
    } catch (error) { setStatus(safeError(error)) }
    finally { endWorking(pending.item.id) }
  }

  const categories = useMemo(() => Array.from(new Set(items.map(item => item.category).filter(Boolean))).sort(), [items])
  const visibleItems = useMemo(() => {
    const normalized = deferredQuery.trim().toLocaleLowerCase()
    const filtered = items.filter(item => {
      if (normalized && !submittedQuery && !`${item.name} ${item.description} ${item.publisher} ${item.category}`.toLocaleLowerCase().includes(normalized)) return false
      if (category !== 'all' && item.category !== category) return false
      if (apiKeyFilter === 'required' && !item.requiresApiKey) return false
      if (apiKeyFilter === 'none' && item.requiresApiKey) return false
      return true
    })
    if (sortBy === 'platform') return filtered
    return [...filtered].sort((left, right) => sortBy === 'downloads'
      ? (right.downloads ?? 0) - (left.downloads ?? 0)
      : sortBy === 'stars'
        ? (right.stars ?? 0) - (left.stars ?? 0)
        : left.name.localeCompare(right.name, 'zh-CN'))
  }, [apiKeyFilter, category, deferredQuery, items, sortBy, submittedQuery])

  const submitSearch = () => {
    const next = query.trim()
    setSubmittedQuery(next)
    if (next) setSection('featured')
  }

  return <section className="skill-market-page">
    <header className="skill-market-header">
      <div><span className="skill-market-logo"><Sparkles size={17} /></span><div><h1>Skill 广场</h1><p>技能、专家套件与工具连接统一管理</p></div></div>
      <button className="icon-button" onClick={onClose} aria-label="关闭 Skill 广场"><X size={20} /></button>
    </header>
    <div className="skill-market-toolbar">
      <nav className="ecosystem-tabs">
        <button className={view === 'skills' ? 'active' : ''} onClick={() => setView('skills')}><Wrench size={14} />技能</button>
        <button className={view === 'experts' ? 'active' : ''} onClick={() => setView('experts')}><UsersRound size={14} />专家套件</button>
        <button className={view === 'connectors' ? 'active' : ''} onClick={() => setView('connectors')}><Cable size={14} />连接器</button>
      </nav>
      {view === 'skills' ? <form onSubmit={event => { event.preventDefault(); submitSearch() }}><Search size={16} /><input value={query} onChange={event => setQuery(event.target.value)} placeholder="按名称、说明或作者搜索" aria-label="搜索技能" />{query ? <button type="button" onClick={() => { setQuery(''); setSubmittedQuery('') }}>清除</button> : null}<button>搜索</button></form> : null}
    </div>
    {view === 'skills' ? <div className="skill-market-content">
      <div className="skill-section-bar"><nav>{(Object.entries(sectionMeta) as Array<[Section, { label: string; description: string }]>).map(([value, meta]) => <button key={value} className={section === value && !submittedQuery ? 'active' : ''} title={meta.description} onClick={() => { setSubmittedQuery(''); setQuery(''); setSection(value) }}>{meta.label}</button>)}</nav><span>{submittedQuery ? '实时搜索结果' : sectionMeta[section].description}</span></div>
      <div className="market-filter-bar"><label>分类<select value={category} onChange={event => setCategory(event.target.value)}><option value="all">全部分类</option>{categories.map(value => <option key={value} value={value}>{safeText(categoryLabel(value))}</option>)}</select></label><label>API Key<select value={apiKeyFilter} onChange={event => setApiKeyFilter(event.target.value as typeof apiKeyFilter)}><option value="all">不限</option><option value="none">无需 API Key</option><option value="required">需要 API Key</option></select></label><label>本地排序<select value={sortBy} onChange={event => setSortBy(event.target.value as SortBy)}><option value="platform">保持平台排序</option><option value="downloads">下载量从高到低</option><option value="stars">收藏量从高到低</option><option value="name">名称 A–Z</option></select></label><b>{visibleItems.length} 个结果</b></div>
      <div className="skill-market-intro"><div><h2>{submittedQuery ? `“${safeText(submittedQuery)}”的搜索结果` : sectionMeta[section].label}</h2><p>{submittedQuery ? '结果来自 SkillHub 实时搜索接口' : '数据来自 SkillHub CLI 使用的官方技能源'}</p></div><button onClick={() => void load()} disabled={loading}><RefreshCw className={loading ? 'spin' : ''} size={14} />刷新</button></div>
      <div className="market-security"><ShieldCheck size={18} /><div><strong>渐进披露与社区信任隔离</strong><p>安装前会预览来源、申请能力和脚本文件。社区 Skill 默认 explicit-only；正文和引用资源按需读取，脚本不自动执行，工具权限取宿主策略、Skill 声明和用户审批的交集。</p></div></div>
      {loading ? <div className="market-empty"><RefreshCw className="spin" size={20} />正在读取 SkillHub…</div> : null}
      {!loading && visibleItems.length ? <div className="skillhub-grid">{visibleItems.map(item => {
        const displayName = safeText(item.name) || '未命名 Skill'
        const working = workingIds.has(item.id) || pendingInstall?.item.id === item.id
        return <article className="skillhub-card" key={item.id} role="button" tabIndex={0} onClick={() => setDetailItem(item)} onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') setDetailItem(item) }}>
          <div className="skillhub-card-head">{item.iconUrl && /^https:\/\//i.test(item.iconUrl) ? <img src={item.iconUrl} alt="" /> : <span><PackageOpen size={20} /></span>}<div><strong title={displayName}>{displayName}</strong><small>{safeText(item.publisher) || '未知发布者'} · v{safeText(item.version) || '未知'}</small></div><button aria-label={`${item.installed ? '卸载' : '安装'} ${displayName}`} className={item.installed ? 'installed' : ''} disabled={working} onClick={(event) => { event.stopPropagation(); void toggle(item) }}>{working ? <RefreshCw className="spin" size={15} /> : item.installed ? <Check size={15} /> : <Download size={15} />}</button></div>
          <p>{safeText(item.description, 500) || '暂无技能说明'}</p>
          <footer><span>{safeText(categoryLabel(item.category))}</span>{item.requiresApiKey ? <em><KeyRound size={11} />需要 API Key</em> : null}{item.stars ? <small><Star size={11} />{formatCount(item.stars)}</small> : null}{item.downloads ? <small><Download size={11} />{formatCount(item.downloads)}</small> : null}</footer>
        </article>
      })}</div> : null}
      {status ? <div className="market-status" role="status" aria-live="polite">{status}</div> : null}
    </div> : null}
    {view === 'experts' ? <SkillHubExperts /> : null}
    {view === 'connectors' ? <EcosystemInfo title="连接器" copy="连接器负责把外部系统变成可调用工具，它与 SKILL.md 的提示词能力不同。" cards={[
      { icon: <Globe2 size={20} />, title: '联网查询', tag: '内置工具', copy: '提供网页搜索与读取能力；是否可用取决于模型工具调用支持和当前网络策略。' },
      { icon: <FolderTree size={20} />, title: '工作区文件', tag: '内置工具', copy: '在授权工作区内读取、创建和修改文件，受“安全与工具”目录白名单约束。' },
      { icon: <TerminalSquare size={20} />, title: 'Shell', tag: '内置工具', copy: '执行本地命令；危险操作按审批模式确认。' },
      { icon: <Cable size={20} />, title: '第三方连接器', tag: '规划中', copy: 'SkillHub CLI 当前没有 connector 子命令。后续应采用独立连接器清单、凭据隔离和工具权限声明，而不是注入 SKILL.md。' },
    ]} note="调研结论：SkillHub CLI 负责 skill / soul / pack；连接器需要由 RanParty 自己的工具协议或 MCP 层接入。" /> : null}
    {detailItem ? <SkillDetailDialog item={detailItem} onClose={() => setDetailItem(null)} onInstall={(selected) => { setDetailItem(null); void toggle(selected) }} /> : null}
    {pendingInstall ? <div className="market-confirm-layer">
      <section className="market-confirm-dialog" role="alertdialog" aria-modal="true" aria-labelledby="market-confirm-title" aria-describedby="market-confirm-note">
        <header><div><ShieldCheck size={20} /><div><strong id="market-confirm-title">确认安装社区 Skill</strong><small>确认信息绑定到本次预览的不可变压缩包</small></div></div><button type="button" className="icon-button" aria-label="关闭安装确认" onClick={() => setPendingInstall(null)}><X size={18} /></button></header>
        <dl className="market-confirm-identity">
          <div><dt>目录名称</dt><dd>{safeText(pendingInstall.item.name) || '未命名 Skill'}</dd></div>
          <div><dt>包内名称</dt><dd>{safeText(pendingInstall.preview.name) || '未声明'}</dd></div>
          <div><dt>目录发布者</dt><dd>{safeText(pendingInstall.item.publisher) || '未知发布者'} <em>目录声明</em></dd></div>
          <div><dt>唯一标识</dt><dd><code>{pendingInstall.slug}</code></dd></div>
          <div><dt>目录 / 包版本</dt><dd>{safeText(pendingInstall.item.version) || '未知'} / {safeText(pendingInstall.preview.version) || '未声明'}</dd></div>
          <div><dt>信任 / 调用</dt><dd>{safeText(pendingInstall.preview.trust)} / {safeText(pendingInstall.preview.invocationPolicy)}</dd></div>
          <div><dt>文件</dt><dd>{pendingInstall.preview.fileCount} 个 · {(pendingInstall.preview.totalBytes / 1024).toFixed(1)} KB</dd></div>
          <div><dt>SHA-256</dt><dd><code>{pendingInstall.preview.archiveSha256}</code></dd></div>
          <div><dt>申请工具</dt><dd>{safeList(pendingInstall.preview.allowedTools, '未声明；使用社区 Skill 的只读默认能力')}</dd></div>
          <div><dt>脚本文件</dt><dd>{safeList(pendingInstall.preview.scriptFiles, '无')}{pendingInstall.preview.scriptFilesTruncated ? `（仅显示前 ${pendingInstall.preview.scriptFiles.length} 个，共 ${pendingInstall.preview.scriptFileCount} 个）` : `（共 ${pendingInstall.preview.scriptFileCount} 个）`}</dd></div>
        </dl>
        {pendingInstall.preview.contentPreview?.trim() ? <div className="market-confirm-preview"><strong>指令预览</strong><pre>{safeMultiline(pendingInstall.preview.contentPreview, 1200)}</pre></div> : null}
        <p id="market-confirm-note" className="market-confirm-note">发布者来自目录声明，并非密码学身份认证。脚本不会自动执行；工具权限只能被 Skill 收窄，仍受宿主策略与审批限制。</p>
        <footer><button type="button" className="outline-button" autoFocus onClick={() => setPendingInstall(null)}>取消</button><button type="button" className="primary-button" onClick={() => void confirmInstall()}><ShieldCheck size={14} />确认安装此摘要</button></footer>
      </section>
    </div> : null}
  </section>
}

function EcosystemInfo({ title, copy, cards, note }: { title: string; copy: string; cards: Array<{ icon: React.ReactNode; title: string; tag: string; copy: string }>; note: string }) {
  return <div className="skill-market-content ecosystem-content"><div className="skill-market-intro"><div><h2>{title}</h2><p>{copy}</p></div></div><div className="ecosystem-grid">{cards.map(card => <article key={card.title}><span>{card.icon}</span><div><header><strong>{card.title}</strong><em>{card.tag}</em></header><p>{card.copy}</p></div></article>)}</div><div className="ecosystem-note"><ShieldCheck size={17} /><span>{note}</span></div></div>
}

function formatCount(value = 0) { return value >= 10000 ? `${(value / 10000).toFixed(1)}万` : String(value) }
function categoryLabel(value = '') {
  const labels: Record<string, string> = { 'ai-agent': 'AI Agent', 'office-efficiency': '办公效率', 'dev-programming': '开发工具', 'data-analysis': '数据分析', 'knowledge-management': '知识管理', professional: '专业服务', 'life-service': '生活服务', 'design-media': '设计创作', installed: '已安装' }
  return labels[value] || value || '其他'
}

function SkillHubExperts() {
  const [items, setItems] = useState<ExpertPack[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [query, setQuery] = useState('')
  const [scene, setScene] = useState('all')
  const [selected, setSelected] = useState<ExpertPack | null>(null)
  const load = useCallback(async (value = query) => {
    setLoading(true); setError('')
    try { const result = await window.ranparty.request<{ items: ExpertPack[] }>('experts.skillhub.list', { query: value.trim() }); setItems(result.items ?? []) }
    catch (reason) { setError(safeError(reason)); setItems([]) }
    finally { setLoading(false) }
  }, [query])
  useEffect(() => { void load(''); return () => {} }, [])
  const scenes = [...new Set(items.map(item => item.scene).filter((value): value is string => Boolean(value)))]
  const visible = scene === 'all' ? items : items.filter(item => item.scene === scene)
  return <div className="skill-market-content ecosystem-content"><div className="skill-market-intro"><div><h2>专家与专家团</h2><p>从完整工作流中选择适合当前任务的专家团队。</p></div><button onClick={() => void load()} disabled={loading}><RefreshCw className={loading ? 'spin' : ''} size={14} />刷新</button></div><section className="expert-scenes"><h3>精选场景</h3><nav><button className={scene === 'all' ? 'active' : ''} onClick={() => setScene('all')}>全部</button>{scenes.map(value => <button className={scene === value ? 'active' : ''} key={value} onClick={() => setScene(value)}>{sceneLabel(value)}</button>)}</nav></section><div className="expert-directory-head"><div><button className="active">专家团</button><button disabled title="SkillHub 暂未开放个人 Soul 目录接口">专家</button></div><form className="expert-search" onSubmit={event => { event.preventDefault(); void load() }}><Search size={15} /><input value={query} onChange={event => setQuery(event.target.value)} placeholder="搜索专家职称或描述" /><button>搜索</button></form></div>{loading ? <div className="market-empty"><RefreshCw className="spin" size={20} />正在读取专家套件…</div> : null}{!loading && visible.length ? <div className="expert-pack-grid">{visible.map(item => <article key={item.id}><button className="expert-pack-main" onClick={() => setSelected(item)}>{item.avatarUrl && /^https:\/\//i.test(item.avatarUrl) ? <img src={item.avatarUrl} alt="" /> : <span><UsersRound size={21} /></span>}<div><h3>{safeText(item.name)}</h3><p>{safeText(item.description, 420) || '暂无套件说明'}</p><footer><em>{sceneLabel(item.scene)}</em><small>{item.skillCount} 位能力成员</small></footer></div></button></article>)}</div> : null}{!loading && !visible.length ? <div className="market-empty">{error || '没有找到专家套件'}</div> : null}<div className="ecosystem-note"><ShieldCheck size={17} /><span>安装后的 Skills 会进入 RanParty 权限与审批体系，不会自动获得额外权限。</span></div>{selected ? <ExpertPackDialog initial={selected} onClose={() => setSelected(null)} /> : null}</div>
}

function ExpertPackDialog({ initial, onClose }: { initial: ExpertPack; onClose: () => void }) {
  const [detail, setDetail] = useState(initial)
  const [loading, setLoading] = useState(true)
  const [copied, setCopied] = useState(false)
  const [installing, setInstalling] = useState(false)
  const [installed, setInstalled] = useState(false)
  useEffect(() => { let active = true; window.ranparty.request<ExpertPack>('experts.skillhub.detail', { slug: initial.slug }).then(value => { if (active) setDetail({ ...initial, ...value, name: value.name || value.displayName || initial.name, description: value.description || value.summary || initial.description }) }).catch(() => {}).finally(() => { if (active) setLoading(false) }); return () => { active = false } }, [initial])
  useEffect(() => { const key = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose() }; window.addEventListener('keydown', key); return () => window.removeEventListener('keydown', key) }, [onClose])
  const command = `skillhub pack install ${initial.slug}`
  const copy = async () => { await window.ranparty.clipboardWrite(command); setCopied(true) }
  const install = async () => { setInstalling(true); try { await window.ranparty.request('experts.skillhub.install', { slug: initial.slug, name: detail.name, description: detail.description }); setInstalled(true); window.dispatchEvent(new Event('ranparty:skills-changed')) } catch (error) { window.alert(`专家团安装失败：${error instanceof Error ? error.message : String(error)}`) } finally { setInstalling(false) } }
  return <div className="expert-detail-layer" onMouseDown={event => { if (event.target === event.currentTarget) onClose() }}><section className="expert-detail-dialog" role="dialog" aria-modal="true" aria-labelledby="expert-detail-title"><header><div><span className="expert-avatar"><UsersRound size={25} /></span><div><h2 id="expert-detail-title">{detail.name}</h2><p>{sceneLabel(detail.scene)} · 专家团 · {detail.skillCount || detail.skillSlugs?.length || 0} 位能力成员</p></div></div><button className="icon-button" aria-label="关闭专家详情" onClick={onClose}><X size={18} /></button></header><main>{loading ? <div className="market-empty"><RefreshCw className="spin" size={18} />加载专家详情…</div> : null}<section><h3>能力介绍</h3><p>{detail.description || '该专家团通过多个 Skills 协作完成完整工作流。'}</p></section><section><h3>擅长领域</h3><div className="expert-skill-tags">{detail.skillSlugs?.map(skill => <span key={skill}>{skill}</span>)}</div></section><section><h3>试试这样问我</h3>{examplePrompts(detail).map(prompt => <button className="expert-example" key={prompt} onClick={() => void window.ranparty.clipboardWrite(prompt)}><span>“{prompt}”</span><span>›</span></button>)}</section></main><footer><button className="primary-button" disabled={installing || installed} onClick={() => void install()}>{installed ? <Check size={15} /> : <Download size={15} />}{installed ? '已安装，可在对话中调用' : installing ? '正在安装专家团…' : '安装此专家团'}</button><button className="expert-copy-command" onClick={() => void copy()}>{copied ? '命令已复制' : '复制 CLI 安装命令'}</button><code>{command}</code></footer></section></div>
}

function sceneLabel(value?: string) { return ({ tech: '技术工程', finance: '金融投资', marketing: '营销增长', media: '内容创作', legal: '法务安全', ecommerce: '电商运营', education: '教育学习', lifestyle: '生活服务', hr: '人力资源', healthcare: '医疗健康', mysticism: '玄学咨询', design: '产品设计' } as Record<string, string>)[value || ''] || value || '综合场景' }
function examplePrompts(item: ExpertPack) { const name = item.name || '这个专家团'; return [`请用${name}的完整流程分析我的需求`, `为这个任务制定一份可执行的工作计划`, `审查现有结果并指出风险与下一步`] }

function validateSlug(value: string) {
  const slug = value.trim()
  if (!/^[\p{L}\p{N}._-]{1,120}$/u.test(slug)) throw new Error('SkillHub slug 格式无效')
  return slug
}

function validatePreview(preview: SkillInstallPreview, slug: string) {
  if (preview.slug !== slug || preview.id !== `skillhub:${slug}`) throw new Error('Skill 预览身份与目录条目不一致，已阻止安装')
  if (!/^[a-f0-9]{64}$/i.test(preview.archiveSha256)) throw new Error('Skill 预览内容摘要无效')
  if (!/^[a-z0-9]{16,128}$/i.test(preview.confirmationToken)) throw new Error('Skill 预览确认令牌无效')
  const expiresAt = Date.parse(preview.confirmationExpiresAt)
  if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) throw new Error('Skill 预览已过期，请重新预览')
  if (!Number.isInteger(preview.fileCount) || preview.fileCount < 1 || !Number.isFinite(preview.totalBytes) || preview.totalBytes < 1) throw new Error('Skill 预览文件统计无效')
  if (!Array.isArray(preview.allowedTools) || !Array.isArray(preview.scriptFiles)) throw new Error('Skill 预览能力清单无效')
  if (!Number.isInteger(preview.scriptFileCount) || preview.scriptFileCount < preview.scriptFiles.length
    || typeof preview.scriptFilesTruncated !== 'boolean'
    || preview.scriptFilesTruncated !== (preview.scriptFileCount > preview.scriptFiles.length)) throw new Error('Skill 预览脚本统计无效')
}

function safeList(values: string[], fallback: string) {
  const cleaned = values.map((value) => safeText(value, 160)).filter(Boolean)
  return cleaned.length ? cleaned.join(', ') : fallback
}

function safeError(error: unknown) {
  return safeText(error instanceof Error ? error.message : String(error), 500) || '未知错误'
}

function safeText(value: unknown, maxLength = 240) {
  return String(value ?? '')
    .normalize('NFC')
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
    .replace(/[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength)
}

function safeMultiline(value: unknown, maxLength: number) {
  return String(value ?? '')
    .normalize('NFC')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, ' ')
    .replace(/[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, '')
    .slice(0, maxLength)
}
