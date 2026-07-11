import { Download, LoaderCircle, ShieldCheck, Star, X } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { MarketplaceSkill } from '../types'

type Tab = 'overview' | 'comments' | 'versions' | 'evaluation'
type Detail = { skill?: { displayName?: string; summary?: string; iconUrl?: string; verified?: boolean; stats?: { stars?: number; downloads?: number } }; latestVersion?: { version?: string }; securityReports?: unknown[] }
type FileList = { files?: Array<{ path?: string } | string> }
type CommentList = { items?: Array<{ id?: string | number; content?: string; text?: string; createdAt?: string; user?: { displayName?: string; handle?: string }; replies?: { total?: number; preview?: Array<{ id?: string | number; content?: string; text?: string; user?: { displayName?: string; handle?: string } }> } }> }
type VersionList = { versions?: Array<{ versionId?: string; version?: string; changelog?: string; createdAt?: string }> }
type EvaluationItem = { score?: number; reason?: string; userReason?: string }
type EvaluationDimension = { reason?: string; userReason?: string; items?: Record<string, EvaluationItem> }
type Evaluation = { available?: boolean; summary?: string; userSummary?: string; dimensions?: Record<string, EvaluationDimension> }

const tabs: Array<{ id: Tab; label: string }> = [{ id: 'overview', label: '概述' }, { id: 'comments', label: '评论' }, { id: 'versions', label: '版本历史' }, { id: 'evaluation', label: '评测报告' }]

export function SkillDetailDialog({ item, onClose, onInstall }: { item: MarketplaceSkill; onClose: () => void; onInstall: (item: MarketplaceSkill) => void }) {
  const slug = item.slug || item.id.replace(/^skillhub:/, '')
  const [tab, setTab] = useState<Tab>('overview')
  const [detail, setDetail] = useState<Detail | null>(null)
  const [data, setData] = useState<Partial<Record<Tab, unknown>>>({})
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const epoch = useRef(0)

  useEffect(() => {
    const current = ++epoch.current; setLoading(true); setError('')
    window.ranparty.request<Detail>('skills.skillhub.detail', { slug }).then(value => { if (epoch.current === current) setDetail(value) }).catch(reason => { if (epoch.current === current) setError(messageOf(reason)) }).finally(() => { if (epoch.current === current) setLoading(false) })
    return () => { epoch.current++ }
  }, [slug])

  const loadTab = useCallback(async (next: Tab) => {
    if (data[next] !== undefined) return
    setLoading(true); setError('')
    try {
      if (next === 'overview') {
        const files = await window.ranparty.request<FileList>('skills.skillhub.files', { slug, version: item.version })
        const paths = (files.files ?? []).map(value => typeof value === 'string' ? value : value.path ?? '')
        const path = ['skill.md', 'readme.md', 'skills.md'].map(name => paths.find(candidate => !candidate.includes('/') && candidate.toLocaleLowerCase() === name)).find(Boolean)
        if (!path) setData(current => ({ ...current, overview: '' }))
        else {
          const result = await window.ranparty.request<{ content?: string }>('skills.skillhub.file', { slug, version: item.version, path })
          setData(current => ({ ...current, overview: stripFrontmatter(result.content ?? '') }))
        }
      } else {
        const method = `skills.skillhub.${next}`
        const result = await window.ranparty.request<unknown>(method, { slug })
        setData(current => ({ ...current, [next]: result }))
      }
    } catch (reason) { setError(messageOf(reason)) }
    finally { setLoading(false) }
  }, [data, item.version, slug])

  useEffect(() => { void loadTab(tab); return () => {} }, [loadTab, tab])
  const title = detail?.skill?.displayName || item.name
  const icon = detail?.skill?.iconUrl || item.iconUrl
  return <div className="skill-detail-layer" onMouseDown={event => { if (event.target === event.currentTarget) onClose() }}>
    <section className="skill-detail-dialog" role="dialog" aria-modal="true" aria-labelledby="skill-detail-title">
      <header><div className="skill-detail-identity">{icon && /^https:\/\//i.test(icon) ? <img src={icon} alt="" /> : <span>SK</span>}<div><h2 id="skill-detail-title">{title}</h2><p>{detail?.skill?.summary || item.description}</p><small>{detail?.skill?.verified ? <><ShieldCheck size={12} />安全认证</> : null}<Star size={12} />{detail?.skill?.stats?.stars ?? item.stars ?? 0} · 下载 {detail?.skill?.stats?.downloads ?? item.downloads ?? 0} · v{detail?.latestVersion?.version || item.version}</small></div></div><div className="skill-detail-actions"><button className="primary-button" onClick={() => onInstall(item)}><Download size={14} />{item.installed ? '卸载' : '安装'}</button><button className="icon-button" aria-label="关闭详情" onClick={onClose}><X size={19} /></button></div></header>
      <nav className="skill-detail-tabs" role="tablist">{tabs.map(value => <button role="tab" aria-selected={tab === value.id} className={tab === value.id ? 'active' : ''} key={value.id} onClick={() => setTab(value.id)}>{value.label}</button>)}</nav>
      <main>{loading && data[tab] === undefined ? <Empty icon={<LoaderCircle className="spin" />} text="正在加载…" /> : null}{error ? <Empty text={error} action={() => void loadTab(tab)} /> : null}{!error && data[tab] !== undefined ? <TabBody tab={tab} value={data[tab]} /> : null}</main>
    </section>
  </div>
}

function TabBody({ tab, value }: { tab: Tab; value: unknown }) {
  if (tab === 'overview') { const content = typeof value === 'string' ? value : ''; return content ? <div className="skill-markdown"><ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml>{content}</ReactMarkdown></div> : <Empty text="暂无概述文档" /> }
  if (tab === 'comments') { const comments = (value as CommentList).items ?? []; return comments.length ? <div className="skill-comments">{comments.map((comment, index) => <article key={comment.id ?? index}><strong>{comment.user?.displayName || comment.user?.handle || 'SkillHub 用户'}</strong><p>{comment.content || comment.text || ''}</p>{comment.replies?.preview?.map((reply, replyIndex) => <blockquote key={reply.id ?? replyIndex}><b>{reply.user?.displayName || reply.user?.handle || '回复'}</b>{reply.content || reply.text}</blockquote>)}</article>)}</div> : <Empty text="暂无评论" /> }
  if (tab === 'versions') { const versions = (value as VersionList).versions ?? []; return versions.length ? <div className="skill-versions">{versions.map((version, index) => <article key={version.versionId ?? version.version ?? index}><strong>v{version.version || version.versionId}</strong><time>{formatDate(version.createdAt)}</time><p>{version.changelog || '未提供版本说明'}</p></article>)}</div> : <Empty text="暂无版本记录" /> }
  const evaluation = value as Evaluation
  const dimensions = evaluation.dimensions ? Object.entries(evaluation.dimensions) : []
  if (evaluation.available === false || !dimensions.length) return <Empty text="暂无评测报告" />
  const scored = dimensions.map(([name, dimension]) => ({ name, dimension, score: dimensionScore(dimension) }))
  const availableScores = scored.map(item => item.score).filter((score): score is number => score !== null)
  const overall = availableScores.length ? availableScores.reduce((sum, score) => sum + score, 0) / availableScores.length : null
  return <div className="skill-evaluation"><section className="trace-summary"><div><b>{overall?.toFixed(1) ?? '—'}</b><span>/ 5</span></div><p>{evaluation.userSummary || evaluation.summary || 'TRACE 从信任、可靠、适应、规范和效果五个维度评估 Skill。'}</p></section>{scored.map(({ name, dimension, score }) => <article key={name}><div><strong>{traceLabel(name)}</strong><span>{score?.toFixed(1) ?? '—'} / 5</span></div><progress max={5} value={score ?? 0} /><p>{dimension.userReason || dimension.reason || ''}</p></article>)}</div>
}
function Empty({ text, icon, action }: { text: string; icon?: React.ReactNode; action?: () => void }) { return <div className="skill-detail-empty">{icon}<p>{text}</p>{action ? <button onClick={action}>重试</button> : null}</div> }
function stripFrontmatter(value: string) { return value.replace(/^\s*---\s*\n[\s\S]*?\n---\s*\n?/, '').trimStart() }
function formatDate(value?: string) { if (!value) return ''; const date = new Date(value); return Number.isNaN(date.getTime()) ? '' : date.toLocaleDateString('zh-CN') }
function traceLabel(value: string) { return ({ trust: 'Trust 信任', reliability: 'Reliability 可靠', adaptability: 'Adaptability 适应', convention: 'Convention 规范', effectiveness: 'Effectiveness 效果' } as Record<string, string>)[value.toLocaleLowerCase()] || value }
function dimensionScore(dimension: EvaluationDimension) { const scores = Object.values(dimension.items ?? {}).map(item => item.score).filter((score): score is number => typeof score === 'number' && Number.isFinite(score)); return scores.length ? scores.reduce((sum, score) => sum + score, 0) / scores.length : null }
function messageOf(reason: unknown) { return reason instanceof Error ? reason.message : String(reason) }
