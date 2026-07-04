import { Check, FolderOpen, LoaderCircle, Sparkles, X } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import type { Profile, Skill } from '../types'

export function NewTaskModal({ initialWorkspace = '', workspaces, profiles, onClose, onBrowse, onCreate }: { initialWorkspace?: string; workspaces: string[]; profiles: Profile[]; onClose: () => void; onBrowse: () => Promise<string>; onCreate: (data: { prompt: string; workspace: string; profileName: string; skillIds: string[] }) => Promise<void> }) {
  const [prompt, setPrompt] = useState('')
  const [workspace, setWorkspace] = useState(initialWorkspace)
  const [profileName, setProfileName] = useState(profiles[0]?.name ?? '')
  const [skills, setSkills] = useState<Skill[]>([])
  const [selected, setSelected] = useState<string[]>([])
  const [creating, setCreating] = useState(false)
  useEffect(() => { window.ranparty.request<{ skills: Skill[] }>('skills.list', { workspace }).then(result => setSkills(result.skills)).catch(() => setSkills([])) }, [workspace])
  const selectedSet = useMemo(() => new Set(selected), [selected])
  const create = async () => { if (!prompt.trim() || !workspace || !profileName) return; setCreating(true); try { await onCreate({ prompt: prompt.trim(), workspace, profileName, skillIds: selected }); onClose() } finally { setCreating(false) } }
  return <div className="new-task-layer"><section className="new-task-modal"><button className="modal-x" onClick={onClose}><X size={20} /></button><div className="task-logo"><Sparkles size={21} /></div><h1>今天想让 AI 帮你做什么？</h1><p>描述任务，选择工作区和本次需要注入的技能。</p><textarea autoFocus value={prompt} onChange={event => setPrompt(event.target.value)} placeholder="例如：梳理当前项目需求，输出一份优先级明确的实施计划…" rows={5} />
    <div className="task-grid"><label><span>工作区</span><div className="task-workspace"><select value={workspace} onChange={event => setWorkspace(event.target.value)}><option value="">选择工作区</option>{workspaces.map(item => <option key={item} value={item}>{name(item)}</option>)}</select><button onClick={async () => { const path = await onBrowse(); if (path) setWorkspace(path) }}><FolderOpen size={16} />浏览</button></div></label><label><span>模型</span><select value={profileName} onChange={event => setProfileName(event.target.value)}>{profiles.map(item => <option key={item.name} value={item.name}>{item.name} · {item.model}</option>)}</select></label></div>
    <div className="task-skills"><span>技能（可多选，默认不注入）</span><div>{skills.map(skill => <button className={selectedSet.has(skill.id) ? 'selected' : ''} key={skill.id} onClick={() => setSelected(current => selectedSet.has(skill.id) ? current.filter(id => id !== skill.id) : [...current, skill.id])}>{selectedSet.has(skill.id) ? <Check size={13} /> : null}{skill.name}</button>)}{skills.length === 0 ? <small>当前工作区没有可用技能，可直接使用默认值。</small> : null}</div></div>
    <footer><button className="outline-button" onClick={onClose}>取消</button><button className="primary-button" disabled={!prompt.trim() || !workspace || creating} onClick={() => void create()}>{creating ? <LoaderCircle className="spin" size={15} /> : <Sparkles size={15} />}{creating ? '正在创建…' : '创建并开始'}</button></footer></section></div>
}
function name(path: string) { return path.split(/[\\/]/).filter(Boolean).at(-1) ?? path }
