import { Boxes, Cable, Check, Download, FolderTree, Globe2, KeyRound, PackageOpen, RefreshCw, Search, ShieldCheck, Sparkles, Star, TerminalSquare, UsersRound, Wrench, X } from 'lucide-react'
import { useCallback, useDeferredValue, useEffect, useMemo, useState } from 'react'
import type { MarketplaceSkill } from '../types'

type Section = 'featured' | 'hot' | 'newest' | 'trending' | 'installed'
type MarketView = 'skills' | 'experts' | 'connectors'
type SortBy = 'platform' | 'downloads' | 'stars' | 'name'

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
  const [workingId, setWorkingId] = useState('')
  const [status, setStatus] = useState('')

  const load = useCallback(async (nextSection = section, nextQuery = submittedQuery) => {
    setLoading(true); setStatus('')
    try {
      const result = await window.ranparty.request<{ items: MarketplaceSkill[] }>('skills.skillhub.list', { section: nextSection, query: nextQuery, workspace })
      setItems(result.items)
      if (!result.items.length) setStatus(nextQuery ? `没有找到“${nextQuery}”相关 Skill` : '当前分类暂无 Skill')
    } catch (error) { setStatus(`SkillHub 暂时不可用：${String(error)}`) }
    finally { setLoading(false) }
  }, [section, submittedQuery, workspace])

  useEffect(() => { if (view === 'skills') void load(section, submittedQuery) }, [section, submittedQuery, workspace, view, load])

  const toggle = async (item: MarketplaceSkill) => {
    setWorkingId(item.id); setStatus('')
    try {
      if (item.installed) await window.ranparty.request('skills.skillhub.uninstall', { id: item.id })
      else await window.ranparty.request('skills.skillhub.install', { slug: item.slug || item.id.replace(/^skillhub:/, '') })
      setItems(current => current.map(candidate => candidate.id === item.id ? { ...candidate, installed: !item.installed } : candidate))
      setStatus(item.installed ? `已卸载 ${item.name}` : `已安全安装 ${item.name}；可在输入框的 Skill 选择器中显式调用`)
    } catch (error) { setStatus(String(error)) }
    finally { setWorkingId('') }
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
      <div className="market-filter-bar"><label>分类<select value={category} onChange={event => setCategory(event.target.value)}><option value="all">全部分类</option>{categories.map(value => <option key={value} value={value}>{categoryLabel(value)}</option>)}</select></label><label>API Key<select value={apiKeyFilter} onChange={event => setApiKeyFilter(event.target.value as typeof apiKeyFilter)}><option value="all">不限</option><option value="none">无需 API Key</option><option value="required">需要 API Key</option></select></label><label>本地排序<select value={sortBy} onChange={event => setSortBy(event.target.value as SortBy)}><option value="platform">保持平台排序</option><option value="downloads">下载量从高到低</option><option value="stars">收藏量从高到低</option><option value="name">名称 A–Z</option></select></label><b>{visibleItems.length} 个结果</b></div>
      <div className="skill-market-intro"><div><h2>{submittedQuery ? `“${submittedQuery}”的搜索结果` : sectionMeta[section].label}</h2><p>{submittedQuery ? '结果来自 SkillHub 实时搜索接口' : '数据来自 SkillHub CLI 使用的官方技能源'}</p></div><button onClick={() => void load()} disabled={loading}><RefreshCw className={loading ? 'spin' : ''} size={14} />刷新</button></div>
      <div className="market-security"><ShieldCheck size={18} /><div><strong>Codex 式按需注入</strong><p>市场只负责安装。聊天时先展示名称和说明，只有你显式选中的 Skill 才会读取完整 SKILL.md，并且只注入下一次发送；不自动执行脚本。</p></div></div>
      {loading ? <div className="market-empty"><RefreshCw className="spin" size={20} />正在读取 SkillHub…</div> : null}
      {!loading && visibleItems.length ? <div className="skillhub-grid">{visibleItems.map(item => <article className="skillhub-card" key={item.id}>
        <div className="skillhub-card-head">{item.iconUrl && /^https:\/\//i.test(item.iconUrl) ? <img src={item.iconUrl} alt="" /> : <span><PackageOpen size={20} /></span>}<div><strong title={item.name}>{item.name}</strong><small>{item.publisher} · v{item.version || '未知'}</small></div><button aria-label={`${item.installed ? '卸载' : '安装'} ${item.name}`} className={item.installed ? 'installed' : ''} disabled={workingId === item.id} onClick={() => void toggle(item)}>{workingId === item.id ? <RefreshCw className="spin" size={15} /> : item.installed ? <Check size={15} /> : <Download size={15} />}</button></div>
        <p>{item.description || '暂无技能说明'}</p>
        <footer><span>{categoryLabel(item.category)}</span>{item.requiresApiKey ? <em><KeyRound size={11} />需要 API Key</em> : null}{item.stars ? <small><Star size={11} />{formatCount(item.stars)}</small> : null}{item.downloads ? <small><Download size={11} />{formatCount(item.downloads)}</small> : null}</footer>
      </article>)}</div> : null}
      {status ? <div className="market-status">{status}</div> : null}
    </div> : null}
    {view === 'experts' ? <EcosystemInfo title="专家套件" copy="SkillHub 的专家能力由 Soul 人格与 Skill Pack 技能包组合而成。" cards={[
      { icon: <UsersRound size={20} />, title: 'Soul 人格', tag: 'SOUL.md', copy: '定义专家的表达、角色和协作方式。RanParty 已将角色卡作为单选会话上下文注入，不会与默认 SOUL 重复叠加。' },
      { icon: <Boxes size={20} />, title: 'Skill Pack 技能包', tag: 'pack', copy: '一套专家工作流可包含多个标准 SKILL.md。SkillHub CLI 支持按 slug 安装 pack；当前公开 CLI 未提供套件列表命令，待平台开放目录 API 后接入一键浏览。' },
    ]} note="已验证 CLI：skillhub soul install <slug> 与 skillhub pack install <slug>。RanParty 不会用普通 Skill 冒充专家套件。" /> : null}
    {view === 'connectors' ? <EcosystemInfo title="连接器" copy="连接器负责把外部系统变成可调用工具，它与 SKILL.md 的提示词能力不同。" cards={[
      { icon: <Globe2 size={20} />, title: '联网查询', tag: '内置工具', copy: '提供网页搜索与读取能力；是否可用取决于模型工具调用支持和当前网络策略。' },
      { icon: <FolderTree size={20} />, title: '工作区文件', tag: '内置工具', copy: '在授权工作区内读取、创建和修改文件，受“安全与工具”目录白名单约束。' },
      { icon: <TerminalSquare size={20} />, title: 'Shell', tag: '内置工具', copy: '执行本地命令；危险操作按审批模式确认。' },
      { icon: <Cable size={20} />, title: '第三方连接器', tag: '规划中', copy: 'SkillHub CLI 当前没有 connector 子命令。后续应采用独立连接器清单、凭据隔离和工具权限声明，而不是注入 SKILL.md。' },
    ]} note="调研结论：SkillHub CLI 负责 skill / soul / pack；连接器需要由 RanParty 自己的工具协议或 MCP 层接入。" /> : null}
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
