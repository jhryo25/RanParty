import { Check, Download, KeyRound, PackageOpen, RefreshCw, Search, ShieldCheck, Sparkles, Star, X } from 'lucide-react'
import { useCallback, useDeferredValue, useEffect, useMemo, useState } from 'react'
import type { MarketplaceSkill } from '../types'

type Section = 'featured' | 'hot' | 'newest' | 'trending' | 'installed'

export function SkillMarketplace({ onClose, workspace = '' }: { onClose: () => void; workspace?: string }) {
  const [items, setItems] = useState<MarketplaceSkill[]>([])
  const [section, setSection] = useState<Section>('featured')
  const [query, setQuery] = useState('')
  const deferredQuery = useDeferredValue(query)
  const [submittedQuery, setSubmittedQuery] = useState('')
  const [loading, setLoading] = useState(true)
  const [workingId, setWorkingId] = useState('')
  const [status, setStatus] = useState('')

  const load = useCallback(async (nextSection = section, nextQuery = submittedQuery) => {
    setLoading(true); setStatus('')
    try {
      const result = await window.ranparty.request<{ items: MarketplaceSkill[] }>('skills.skillhub.list', { section: nextSection, query: nextQuery, workspace })
      setItems(result.items)
      if (!result.items.length) setStatus(nextQuery ? `没有找到”${nextQuery}”相关 Skill` : '当前分类暂无 Skill')
    } catch (error) { setStatus(`SkillHub 暂时不可用：${String(error)}`) }
    finally { setLoading(false) }
  }, [section, submittedQuery, workspace])

  useEffect(() => { void load(section, submittedQuery) }, [section, submittedQuery, workspace])

  const toggle = async (item: MarketplaceSkill) => {
    setWorkingId(item.id); setStatus('')
    try {
      if (item.installed) {
        await window.ranparty.request('skills.skillhub.uninstall', { id: item.id })
      } else {
        await window.ranparty.request('skills.skillhub.install', { slug: item.slug || item.id.replace(/^skillhub:/, '') })
      }
      setItems(current => current.map(candidate => candidate.id === item.id ? { ...candidate, installed: !item.installed } : candidate))
      setStatus(item.installed ? `已卸载 ${item.name}` : `已安全安装 ${item.name}；可在输入框的 Skill 选择器中显式调用`)
    } catch (error) { setStatus(String(error)) }
    finally { setWorkingId('') }
  }

  const visibleItems = useMemo(() => {
    const normalized = deferredQuery.trim().toLocaleLowerCase()
    if (!normalized || submittedQuery) return items
    return items.filter(item => `${item.name} ${item.description} ${item.publisher} ${item.category}`.toLocaleLowerCase().includes(normalized))
  }, [deferredQuery, items, submittedQuery])

  const submitSearch = () => {
    const next = query.trim()
    setSubmittedQuery(next)
    if (next) setSection('featured')
  }

  return <section className="skill-market-page">
    <header className="skill-market-header">
      <div><span className="skill-market-logo"><Sparkles size={17} /></span><div><h1>Skill 广场</h1><p>发现、安装并统一管理 RanParty 的能力扩展</p></div></div>
      <button className="icon-button" onClick={onClose} aria-label="关闭 Skill 广场"><X size={20} /></button>
    </header>
    <div className="skill-market-toolbar">
      <nav>{([['featured', '精选'], ['hot', '热门'], ['newest', '最新'], ['trending', '趋势'], ['installed', '我安装的']] as const).map(([value, label]) => <button key={value} className={section === value && !submittedQuery ? 'active' : ''} onClick={() => { setSubmittedQuery(''); setQuery(''); setSection(value) }}>{label}</button>)}</nav>
      <form onSubmit={event => { event.preventDefault(); submitSearch() }}><Search size={16} /><input value={query} onChange={event => setQuery(event.target.value)} placeholder="搜索 SkillHub 技能" aria-label="搜索技能" /><button>搜索</button></form>
    </div>
    <div className="skill-market-content">
      <div className="skill-market-intro"><div><h2>{submittedQuery ? `“${submittedQuery}”的搜索结果` : section === 'installed' ? '已安装技能' : 'SkillHub 推荐'}</h2><p>{submittedQuery ? '结果来自 SkillHub 实时搜索接口' : '来自 SkillHub CLI 使用的官方技能源'}</p></div><button onClick={() => void load()} disabled={loading}><RefreshCw className={loading ? 'spin' : ''} size={14} />刷新</button></div>
      <div className="market-security"><ShieldCheck size={18} /><div><strong>Codex 式按需注入</strong><p>市场只负责安装。聊天时先展示名称和说明，只有你显式选中的 Skill 才会读取完整 SKILL.md，并且只注入下一次发送；不自动执行脚本。</p></div></div>
      {loading ? <div className="market-empty"><RefreshCw className="spin" size={20} />正在读取 SkillHub…</div> : null}
      {!loading && visibleItems.length ? <div className="skillhub-grid">{visibleItems.map(item => <article className="skillhub-card" key={item.id}>
        <div className="skillhub-card-head">{item.iconUrl && /^https:\/\//i.test(item.iconUrl) ? <img src={item.iconUrl} alt="" /> : <span><PackageOpen size={20} /></span>}<div><strong title={item.name}>{item.name}</strong><small>{item.publisher} · v{item.version || '未知'}</small></div><button aria-label={`${item.installed ? '卸载' : '安装'} ${item.name}`} className={item.installed ? 'installed' : ''} disabled={workingId === item.id} onClick={() => void toggle(item)}>{workingId === item.id ? <RefreshCw className="spin" size={15} /> : item.installed ? <Check size={15} /> : <Download size={15} />}</button></div>
        <p>{item.description || '暂无技能说明'}</p>
        <footer><span>{categoryLabel(item.category)}</span>{item.requiresApiKey ? <em><KeyRound size={11} />需要 API Key</em> : null}{item.stars ? <small><Star size={11} />{formatCount(item.stars)}</small> : null}{item.downloads ? <small><Download size={11} />{formatCount(item.downloads)}</small> : null}</footer>
      </article>)}</div> : null}
      {status ? <div className="market-status">{status}</div> : null}
    </div>
  </section>
}

function formatCount(value = 0) { return value >= 10000 ? `${(value / 10000).toFixed(1)}万` : String(value) }
function categoryLabel(value = '') {
  const labels: Record<string, string> = { 'ai-agent': 'AI Agent', 'office-efficiency': '办公效率', 'dev-programming': '开发工具', 'data-analysis': '数据分析', 'knowledge-management': '知识管理', professional: '专业服务', 'life-service': '生活服务', 'design-media': '设计创作', installed: '已安装' }
  return labels[value] || value || '其他'
}
