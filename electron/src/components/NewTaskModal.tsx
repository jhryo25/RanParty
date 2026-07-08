import { Check, FolderOpen, LoaderCircle, RefreshCw, Search, Sparkles, X } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import type { Profile, Skill } from '../types'

export function NewTaskModal({
  initialWorkspace = '',
  workspaces,
  profiles,
  onClose,
  onBrowse,
  onCreate,
}: {
  initialWorkspace?: string
  workspaces: string[]
  profiles: Profile[]
  onClose: () => void
  onBrowse: () => Promise<string>
  onCreate: (data: { prompt: string; workspace: string; profileName: string; skillIds: string[] }) => Promise<void>
}) {
  const [prompt, setPrompt] = useState('')
  const [workspace, setWorkspace] = useState(initialWorkspace)
  const [localWorkspaces, setLocalWorkspaces] = useState<string[]>([])
  const [profileName, setProfileName] = useState(profiles[0]?.name ?? '')
  const [skills, setSkills] = useState<Skill[]>([])
  const [selected, setSelected] = useState<string[]>([])
  const [query, setQuery] = useState('')
  const [loadingSkills, setLoadingSkills] = useState(false)
  const [skillError, setSkillError] = useState('')
  const [creating, setCreating] = useState(false)
  const [localError, setLocalError] = useState('')

  const loadSkills = useCallback(async () => {
    setLoadingSkills(true)
    setSkillError('')
    try {
      const result = await window.ranparty.request<{ skills: Skill[] }>('skills.list', { workspace })
      setSkills(result.skills)
    } catch (error) {
      setSkills([])
      setSkillError(error instanceof Error ? error.message : String(error))
    } finally {
      setLoadingSkills(false)
    }
  }, [workspace])

  useEffect(() => {
    let cancelled = false
    setLoadingSkills(true)
    setSkillError('')
    window.ranparty.request<{ skills: Skill[] }>('skills.list', { workspace })
      .then(result => { if (!cancelled) setSkills(result.skills) })
      .catch(error => { if (!cancelled) { setSkills([]); setSkillError(error instanceof Error ? error.message : String(error)) } })
      .finally(() => { if (!cancelled) setLoadingSkills(false) })
    return () => { cancelled = true }
  }, [workspace])

  useEffect(() => {
    const refresh = () => void loadSkills()
    window.addEventListener('ranparty:skills-changed', refresh)
    return () => window.removeEventListener('ranparty:skills-changed', refresh)
  }, [loadSkills])

  const workspaceOptions = useMemo(() => {
    const options = [...workspaces, ...localWorkspaces]
    if (workspace && !options.includes(workspace)) options.unshift(workspace)
    return [...new Set(options)]
  }, [localWorkspaces, workspace, workspaces])

  const selectedSet = useMemo(() => new Set(selected), [selected])
  const filteredSkills = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase()
    if (!normalized) return skills
    return skills.filter(skill => `${skill.name} ${skill.description} ${skill.source} ${skill.pathLabel}`.toLocaleLowerCase().includes(normalized))
  }, [query, skills])

  const browse = async () => {
    const path = await onBrowse()
    if (!path) return
    setWorkspace(path)
    setLocalWorkspaces((current) => current.includes(path) ? current : [path, ...current])
  }

  const create = async () => {
    if (!prompt.trim() || !workspace || !profileName) return
    setCreating(true)
    setLocalError('')
    try {
      await onCreate({ prompt: prompt.trim(), workspace, profileName, skillIds: selected })
      onClose()
    } catch (error) {
      setLocalError(error instanceof Error ? error.message : String(error))
    } finally {
      setCreating(false)
    }
  }

  const toggleSkill = (id: string) => {
    setSelected((current) => current.includes(id) ? current.filter(item => item !== id) : [...current, id])
  }

  return <div className="new-task-layer">
    <section className="new-task-modal">
      <button className="modal-x" onClick={onClose} aria-label="关闭"><X size={20} /></button>
      <div className="task-logo"><Sparkles size={21} /></div>
      <h1>今天想让 AI 帮你做什么？</h1>
      <p>描述任务，选择工作区和本次需要注入的技能。</p>
      <textarea autoFocus value={prompt} onChange={event => setPrompt(event.target.value)} placeholder="例如：梳理当前项目需求，输出一份优先级明确的实施计划…" rows={5} />
      {localError ? <div className="new-task-error" role="alert">{localError}<button onClick={() => setLocalError('')}><X size={12} /></button></div> : null}
      <div className="task-grid">
        <label className="task-workspace-field">
          <span>工作区</span>
          <div className="task-workspace">
            <select value={workspace} onChange={event => setWorkspace(event.target.value)} title={workspace || '选择工作区'}>
              <option value="">选择工作区</option>
              {workspaceOptions.map(item => <option key={item} value={item}>{name(item)}</option>)}
            </select>
            <button className="task-browse-button" type="button" title="浏览本机文件夹" onClick={() => void browse()}><FolderOpen size={16} />浏览</button>
          </div>
          {workspace ? <small className="task-workspace-path" title={workspace}>{workspace}</small> : <small className="task-workspace-path muted">选择一个目录后才能创建并开始。</small>}
        </label>
        <label>
          <span>模型</span>
          <select value={profileName} onChange={event => setProfileName(event.target.value)}>
            {profiles.map(item => <option key={item.name} value={item.name}>{item.name} · {item.model}</option>)}
          </select>
        </label>
      </div>

      <div className="task-skills">
        <div className="task-skills-head">
          <span>技能（可多选，默认不注入）</span>
          <button type="button" className="task-refresh-button" onClick={() => void loadSkills()} disabled={loadingSkills}><RefreshCw size={13} className={loadingSkills ? 'spin' : ''} />刷新</button>
        </div>
        <label className="task-skill-search"><Search size={14} /><input value={query} onChange={event => setQuery(event.target.value)} placeholder="搜索已安装 Skill" /></label>
        <div className="task-skill-list">
          {filteredSkills.map(skill => (
            <button type="button" className={selectedSet.has(skill.id) ? 'selected' : ''} key={skill.id} onClick={() => toggleSkill(skill.id)} title={skill.description || skill.pathLabel}>
              {selectedSet.has(skill.id) ? <Check size={13} /> : null}
              <span>{skill.name}</span>
              <small>{skill.source}</small>
            </button>
          ))}
          {!loadingSkills && skills.length === 0 && !skillError ? <small className="task-empty">当前没有可用 Skill。可以先到 Skill 广场安装，或继续使用默认能力。</small> : null}
          {!loadingSkills && skills.length > 0 && filteredSkills.length === 0 ? <small className="task-empty">没有匹配的 Skill。</small> : null}
          {skillError ? <small className="task-empty error">Skill 读取失败：{skillError}</small> : null}
        </div>
      </div>

      <footer>
        <button className="outline-button" onClick={onClose}>取消</button>
        <button className="primary-button" disabled={!prompt.trim() || !workspace || creating} onClick={() => void create()}>
          {creating ? <LoaderCircle className="spin" size={15} /> : <Sparkles size={15} />}
          {creating ? '正在创建…' : '创建并开始'}
        </button>
      </footer>
    </section>
  </div>
}

function name(path: string) {
  return path.split(/[\\/]/).filter(Boolean).at(-1) ?? path
}
