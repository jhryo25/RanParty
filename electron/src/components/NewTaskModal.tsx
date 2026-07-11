import { ArrowLeft, Check, FolderOpen, ImagePlus, LoaderCircle, RefreshCw, Search, Sparkles, X } from 'lucide-react'
import { type ClipboardEvent, type DragEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Attachment, ExpertTeamDefinition, Profile, Skill } from '../types'
import { MAX_IMAGE_BYTES, MAX_IMAGES } from './composer-store'
import { filesToAttachments, isExpertSkill } from './composer-utils'

interface Props {
  initialWorkspace?: string
  workspaces: string[]
  profiles: Profile[]
  onClose: () => void
  onBrowse: () => Promise<string>
  onCreate: (data: { clientMessageId: string; prompt: string; workspace: string; profileName: string; imageDataUrls: string[]; skillIds: string[]; expertIds: string[]; expertTeamId?: string }) => Promise<void>
}

export function NewTaskPage({ initialWorkspace = '', workspaces, profiles, onClose, onBrowse, onCreate }: Props) {
  const [prompt, setPrompt] = useState('')
  const [workspace, setWorkspace] = useState(initialWorkspace)
  const [localWorkspaces, setLocalWorkspaces] = useState<string[]>([])
  const [profileName, setProfileName] = useState(profiles[0]?.name ?? '')
  const [skills, setSkills] = useState<Skill[]>([])
  const [skillIds, setSkillIds] = useState<string[]>([])
  const [expertIds, setExpertIds] = useState<string[]>([])
  const [teams, setTeams] = useState<ExpertTeamDefinition[]>([])
  const [expertTeamId, setExpertTeamId] = useState('')
  const [attachments, setAttachments] = useState<Attachment[]>([])
  const [query, setQuery] = useState('')
  const [loading, setLoading] = useState(false)
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState('')
  const submitRef = useRef<{ fingerprint: string; id: string } | null>(null)
  const epochRef = useRef(0)

  const load = useCallback(async () => {
    const epoch = ++epochRef.current; setLoading(true); setError('')
    try {
      const [result, expertResult] = await Promise.all([window.ranparty.request<{ skills: Skill[] }>('skills.list', { workspace }), window.ranparty.request<{ teams: ExpertTeamDefinition[] }>('experts.list')])
      if (epoch !== epochRef.current) return
      setSkills(result.skills)
      setTeams(expertResult.teams ?? [])
      const visible = new Set(result.skills.map(skill => skill.id))
      setSkillIds(current => current.filter(id => visible.has(id)))
      setExpertIds(current => current.filter(id => visible.has(id)))
    } catch (reason) { if (epoch === epochRef.current) setError(messageOf(reason)) }
    finally { if (epoch === epochRef.current) setLoading(false) }
  }, [workspace])

  useEffect(() => { void load(); return () => { epochRef.current++ } }, [load])
  useEffect(() => { const refresh = () => void load(); window.addEventListener('ranparty:skills-changed', refresh); return () => window.removeEventListener('ranparty:skills-changed', refresh) }, [load])

  const dirty = Boolean(prompt.trim() || attachments.length || skillIds.length || expertIds.length || expertTeamId)
  const close = useCallback(() => { if (!creating && (!dirty || window.confirm('放弃尚未提交的新任务内容吗？'))) onClose() }, [creating, dirty, onClose])
  useEffect(() => { const key = (event: KeyboardEvent) => { if (event.key === 'Escape') close() }; window.addEventListener('keydown', key); return () => window.removeEventListener('keydown', key) }, [close])

  const addImages = useCallback((incoming: Attachment[]) => {
    setAttachments(current => {
      const valid = incoming.filter(item => item.dataUrl.startsWith('data:image/') && (item.size ?? 0) <= MAX_IMAGE_BYTES)
      if (valid.length !== incoming.length) setError('仅支持不超过 10MB 的图片。')
      if (current.length + valid.length > MAX_IMAGES) setError(`最多添加 ${MAX_IMAGES} 张图片。`)
      return [...current, ...valid.slice(0, Math.max(0, MAX_IMAGES - current.length))]
    })
  }, [])
  const paste = async (event: ClipboardEvent<HTMLTextAreaElement>) => { const files = [...event.clipboardData.files].filter(file => file.type.startsWith('image/')); if (!files.length) return; event.preventDefault(); addImages(await filesToAttachments(files)) }
  const drop = async (event: DragEvent<HTMLElement>) => { event.preventDefault(); const files = [...event.dataTransfer.files].filter(file => file.type.startsWith('image/')); if (files.length) addImages(await filesToAttachments(files)) }
  const chooseImages = async () => { try { addImages(await window.ranparty.chooseImages()) } catch (reason) { setError(messageOf(reason)) } }
  const browse = async () => { const path = await onBrowse(); if (!path) return; setWorkspace(path); setLocalWorkspaces(current => current.includes(path) ? current : [path, ...current]) }
  const create = async () => {
    if ((!prompt.trim() && !attachments.length) || !workspace || !profileName || creating) return
    setCreating(true); setError('')
    const payload = { prompt: prompt.trim(), workspace, profileName, imageDataUrls: attachments.map(item => item.dataUrl), skillIds, expertIds: expertTeamId ? [] : expertIds, expertTeamId: expertTeamId || undefined }
    const fingerprint = JSON.stringify(payload)
    if (submitRef.current?.fingerprint !== fingerprint) submitRef.current = { fingerprint, id: `task_${Date.now()}_${Math.random().toString(36).slice(2, 9)}` }
    try { await onCreate({ ...payload, clientMessageId: submitRef.current.id }); submitRef.current = null; onClose() }
    catch (reason) { setError(messageOf(reason)) }
    finally { setCreating(false) }
  }
  const options = [...new Set([...(workspace ? [workspace] : []), ...localWorkspaces, ...workspaces])]
  const filtered = useMemo(() => { const value = query.trim().toLocaleLowerCase(); return skills.filter(skill => !value || `${skill.name} ${skill.description} ${skill.source}`.toLocaleLowerCase().includes(value)) }, [query, skills])
  const regular = filtered.filter(skill => !isExpertSkill(skill)); const experts = filtered.filter(isExpertSkill)
  const toggle = (expert: boolean, id: string) => (expert ? setExpertIds : setSkillIds)(current => current.includes(id) ? current.filter(value => value !== id) : [...current, id])

  return <section className="new-task-page" role="main" aria-label="今天想让 AI 帮你做什么？" onDragOver={event => event.preventDefault()} onDrop={event => void drop(event)}>
    <header className="new-task-page-header"><button className="icon-button" onClick={close} aria-label="返回"><ArrowLeft size={20} /></button><div><h1>新建任务</h1><p>描述目标，选择工作区和本次需要的能力。</p></div></header>
    <div className="new-task-modal">
      <div className="task-logo"><Sparkles size={21} /></div><h1>今天想让 AI 帮你做什么？</h1><p>支持直接粘贴或拖入图片。</p>
      <textarea autoFocus value={prompt} onChange={event => setPrompt(event.target.value)} onPaste={event => void paste(event)} placeholder="例如：审查当前项目并给出改进方案；也可以直接粘贴截图。" rows={5} />
      {attachments.length ? <div className="task-attachments">{attachments.map((item, index) => <figure key={`${item.name}-${index}`}><img src={item.dataUrl} alt={item.name} /><button aria-label={`移除 ${item.name}`} onClick={() => setAttachments(current => current.filter((_, candidate) => candidate !== index))}><X size={13} /></button></figure>)}</div> : null}
      <button type="button" className="task-image-button" onClick={() => void chooseImages()}><ImagePlus size={15} />添加图片</button>
      {error ? <div className="new-task-error" role="alert">{error}<button onClick={() => setError('')}><X size={12} /></button></div> : null}
      <div className="task-grid"><label><span>工作区</span><div className="task-workspace"><select value={workspace} onChange={event => setWorkspace(event.target.value)}><option value="">选择工作区</option>{options.map(item => <option key={item} value={item}>{shortName(item)}</option>)}</select><button type="button" onClick={() => void browse()}><FolderOpen size={15} />浏览</button></div><small>{workspace || '必须选择一个工作目录'}</small></label><label><span>模型</span><select value={profileName} onChange={event => setProfileName(event.target.value)}>{profiles.map(profile => <option key={profile.name} value={profile.name}>{profile.name} · {profile.model}</option>)}</select></label></div>
      <div className="task-skills"><div className="task-skills-head"><span>Skills 与专家</span><button onClick={() => void load()} disabled={loading}><RefreshCw size={13} className={loading ? 'spin' : ''} />刷新</button></div><label className="task-skill-search"><Search size={14} /><input value={query} onChange={event => setQuery(event.target.value)} placeholder="搜索已安装能力" /></label><SkillGroup title="Skills" items={regular} selected={skillIds} onToggle={id => toggle(false, id)} /><SkillGroup title="专家" items={experts} selected={expertIds} onToggle={id => { setExpertTeamId(''); toggle(true, id) }} />{teams.length ? <label className="task-team-select"><span>专家团队（与单专家互斥）</span><select value={expertTeamId} onChange={event => { setExpertTeamId(event.target.value); if (event.target.value) setExpertIds([]) }}><option value="">不使用专家团队</option>{teams.map(team => <option key={team.id} value={team.id}>{team.name} · {team.memberSkillIds.length + 1} 位成员</option>)}</select></label> : null}</div>
      <footer><button className="outline-button" onClick={close}>取消</button><button className="primary-button" disabled={(!prompt.trim() && !attachments.length) || !workspace || !profileName || creating} onClick={() => void create()}>{creating ? <LoaderCircle className="spin" size={15} /> : <Sparkles size={15} />}{creating ? '正在创建…' : '创建并开始'}</button></footer>
    </div>
  </section>
}

function SkillGroup({ title, items, selected, onToggle }: { title: string; items: Skill[]; selected: string[]; onToggle: (id: string) => void }) { return <div className="task-skill-group"><strong>{title}</strong><div className="task-skill-list">{items.map(skill => <button type="button" className={selected.includes(skill.id) ? 'selected' : ''} key={skill.id} onClick={() => onToggle(skill.id)}>{selected.includes(skill.id) ? <Check size={13} /> : null}<span>{skill.name}</span><small>{skill.source}</small></button>)}{!items.length ? <small className="task-empty">暂无可用{title}</small> : null}</div></div> }
function shortName(path: string) { return path.split(/[\\/]/).filter(Boolean).at(-1) ?? path }
function messageOf(reason: unknown) { return reason instanceof Error ? reason.message : String(reason) }

/** @deprecated Use NewTaskPage. */
export const NewTaskModal = NewTaskPage
