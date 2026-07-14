import { AtSign, Cable, Check, ChevronRight, Circle, FilePlus2, Search, Users, Wrench } from 'lucide-react'
import { ReactNode } from 'react'
import type { ConnectorConfig, ExpertTeamDefinition, Profile, Session, Skill } from '../types'
import { connectorStatus, formatLastActive } from './composer-utils'

export type QuickPanel = 'reference' | 'mode' | 'experts' | 'skills' | 'connectors'

interface ComposerQuickMenuProps {
  activeProfile?: Profile
  hasVisionHelper: boolean
  canAttachImages: boolean
  quickPanel: QuickPanel | null
  selectedExpertsCount: number
  selectedSkillsCount: number
  referenceItems: Session[]
  selectedReferenceIds: string[]
  referenceQuery: string
  onReferenceQuery: (value: string) => void
  expertItems: Skill[]
  selectedExpertIds: string[]
  expertTeams: ExpertTeamDefinition[]
  selectedExpertTeamId: string
  skillItems: Skill[]
  selectedSkillIds: string[]
  skillQuery: string
  onSkillQuery: (value: string) => void
  connectors: ConnectorConfig[]
  onChooseImages: () => Promise<void>
  onOpenPanel: (panel: QuickPanel) => void
  onAddReference: (id: string) => void
  onToggleExpert: (id: string) => void
  onSelectExpertTeam: (id: string) => void
  onToggleSkill: (id: string) => void
  onOpenSkills?: () => void
}

export function ComposerQuickMenu(props: ComposerQuickMenuProps) {
  const {
    activeProfile, hasVisionHelper, canAttachImages, quickPanel, selectedExpertsCount, selectedSkillsCount,
    referenceItems, selectedReferenceIds, referenceQuery, onReferenceQuery, expertItems, selectedExpertIds, expertTeams, selectedExpertTeamId,
    skillItems, selectedSkillIds, skillQuery, onSkillQuery, connectors, onChooseImages, onOpenPanel,
    onAddReference, onToggleExpert, onSelectExpertTeam, onToggleSkill, onOpenSkills,
  } = props
  return <div className="composer-menu-shell compact-menu-shell" role="dialog" aria-label="输入资源菜单">
    <div className="control-popover composer-command-menu">
      <MenuButton icon={<FilePlus2 size={16} />} title="添加文件" copy={activeProfile?.supportsImages ? '添加或粘贴图片附件' : hasVisionHelper ? '当前模型不支持图片，将交给视觉子 Agent 识别' : '未配置支持图片输入的模型'} onClick={() => void onChooseImages()} disabled={!canAttachImages} />
      <MenuButton icon={<AtSign size={16} />} title="引用对话中的文件" copy="从产物或工作区文件引用" panel="reference" active={quickPanel === 'reference'} onHover={onOpenPanel} />
      <hr />
      <MenuButton icon={<Users size={16} />} title="专家" copy={selectedExpertsCount ? `已选择 ${selectedExpertsCount} 个专家` : '选择 Skill 广场专家套件'} panel="experts" active={quickPanel === 'experts'} onHover={onOpenPanel} />
      <MenuButton icon={<Wrench size={16} />} title="技能" copy={selectedSkillsCount ? `已选择 ${selectedSkillsCount} 个技能` : '显式选择，仅注入下一次发送'} panel="skills" active={quickPanel === 'skills'} onHover={onOpenPanel} />
      <MenuButton icon={<Cable size={16} />} title="连接器" copy="MCP server 与内置工具权限" panel="connectors" active={quickPanel === 'connectors'} onHover={onOpenPanel} />
    </div>
    {quickPanel ? <div className="control-popover composer-command-submenu">
      {quickPanel === 'reference' ? <ReferencePanel items={referenceItems} selected={selectedReferenceIds} query={referenceQuery} setQuery={onReferenceQuery} onAdd={onAddReference} /> : null}
      {quickPanel === 'experts' ? <><div className="submenu-title">专家团</div><div className="popover-list compact">{expertTeams.map(team => <button className="skill-option" key={team.id} onClick={() => onSelectExpertTeam(team.id)}><span className="check-box">{selectedExpertTeamId === team.id ? <Check size={13} /> : <Users size={13} />}</span><span><strong>{team.name}</strong><small>{team.description || `${team.memberSkillIds.length + 1} 位成员协作`}</small></span></button>)}</div><SkillPickPanel title="单专家" empty="尚未安装可用专家。请到 Skill 广场安装。" items={expertItems} selected={selectedExpertIds} query={skillQuery} setQuery={onSkillQuery} onOpenSkills={onOpenSkills} onToggle={onToggleExpert} /></> : null}
      {quickPanel === 'skills' ? <SkillPickPanel title="可用技能" empty="没有找到可用 Skill。请先到 Skill 广场安装，或检查 Skill 是否包含 SKILL.md。" items={skillItems} selected={selectedSkillIds} query={skillQuery} setQuery={onSkillQuery} onOpenSkills={onOpenSkills} onToggle={onToggleSkill} /> : null}
      {quickPanel === 'connectors' ? <ConnectorPanel connectors={connectors} /> : null}
    </div> : null}
  </div>
}

interface MenuButtonProps {
  icon: ReactNode
  title: string
  copy: string
  panel?: QuickPanel
  active?: boolean
  disabled?: boolean
  onHover?: (panel: QuickPanel) => void
  onClick?: () => void
}

function MenuButton({ icon, title, copy, panel, active, disabled, onHover, onClick }: MenuButtonProps) {
  return <button
    type="button"
    className={`${active ? 'active' : ''} ${disabled ? 'disabled' : ''}`}
    disabled={disabled}
    onMouseEnter={() => panel && onHover?.(panel)}
    onClick={() => panel ? onHover?.(panel) : onClick?.()}
  >
    {icon}<span><strong>{title}</strong><small>{copy}</small></span>{panel ? <ChevronRight size={14} /> : null}
  </button>
}

interface ReferencePanelProps {
  items: Session[]
  selected: string[]
  query: string
  setQuery: (value: string) => void
  onAdd: (id: string) => void
}

function ReferencePanel({ items, selected, query, setQuery, onAdd }: ReferencePanelProps) {
  return <>
    <label className="submenu-search"><Search size={15} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索历史会话" /></label>
    <div className="submenu-title">引用历史会话</div>
    <p className="reference-help">会话引用会把对方的交接摘要、最近摘录和产物路径注入下一轮上下文，不会复制完整聊天历史。</p>
    <div className="popover-list compact reference-list">
      {items.map((item) => (
        <button className="skill-option" key={item.id} onClick={() => onAdd(item.id)}>
          <span className="check-box">{selected.includes(item.id) ? <Check size={13} /> : <AtSign size={13} />}</span>
          <span><strong>{item.title}</strong><small>{item.workspace || '未选择工作区'}</small><em>{formatLastActive(item.lastActive)} · {item.id}</em></span>
        </button>
      ))}
      {items.length === 0 ? <p className="popover-empty">没有可引用的其他会话。也可以右键左侧会话复制 @session 引用后粘贴到输入框。</p> : null}
    </div>
  </>
}

interface SkillPickPanelProps {
  title: string
  empty: string
  items: Skill[]
  selected: string[]
  query: string
  setQuery: (value: string) => void
  onToggle: (id: string) => void
  onOpenSkills?: () => void
}

function SkillPickPanel(props: SkillPickPanelProps) {
  const { title, empty, items, selected, query, setQuery, onToggle, onOpenSkills } = props
  return <>
    <label className="submenu-search"><Search size={15} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={`搜索${title.replace('可用', '')}`} /></label>
    <div className="submenu-title">{title}</div>
    <div className="popover-list compact">
      {items.map((skill) => {
        const checked = selected.includes(skill.id)
        return <button className={`skill-option ${checked ? 'selected' : ''}`} key={skill.id} onClick={() => onToggle(skill.id)}>
          <span className="check-box">{checked ? <Check size={13} /> : null}</span>
          <span><strong>{skill.name}</strong><small>{skill.description || skill.pathLabel}</small><em>{skill.source}</em></span>
        </button>
      })}
      {items.length === 0 ? <p className="popover-empty">{empty}</p> : null}
    </div>
    <div className="submenu-footer"><button type="button" onClick={onOpenSkills}>打开 Skill 广场</button></div>
  </>
}

interface ConnectorPanelProps {
  connectors: ConnectorConfig[]
}

function ConnectorPanel({ connectors }: ConnectorPanelProps) {
  return <div className="mode-panel connector-panel">
    <p>连接器按 MCP server 思路管理：默认不向模型暴露危险工具，需要先启用 server，再按工具允许列表开放。</p>
    {connectors.length ? connectors.map((connector) => (
      <button type="button" className="toggle-row" key={connector.id}>
        <span><strong>{connector.name}</strong><small>{connector.type} · {connectorStatus(connector)}</small></span>
        <Circle size={16} />
      </button>
    )) : <button type="button" className="toggle-row disabled"><span><strong>暂无连接器</strong><small>前往设置或后续连接器管理页新增 MCP server</small></span><Circle size={16} /></button>}
  </div>
}
