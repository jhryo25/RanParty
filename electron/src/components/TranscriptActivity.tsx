import { AlertTriangle, CheckCircle2, ChevronDown, Files, LoaderCircle, Square } from 'lucide-react'
import { memo, useState, type MouseEvent } from 'react'
import type { ThreadItem, ToolResultItem } from '../types'
import { isToolResult } from '../types'
import { resourceFileName } from './transcript-resource'

interface TaskActivityProps {
  items: ThreadItem[]
  onOpenResource: (target: string) => void
  onContextResource: (event: MouseEvent, target: string) => void
}

interface ToolEntryProps {
  item: ToolResultItem
  onOpenResource: (target: string) => void
  onContextResource: (event: MouseEvent, target: string) => void
}

interface ArtifactSummaryProps {
  files: string[]
  onOpenResource: (target: string) => void
  onContextResource: (event: MouseEvent, target: string) => void
}

const TOOL_INTENT: Record<string, string> = {
  web_search: '搜索资料', web_search_cached: '搜索资料', web_fetch: '读取网页', web_fetch_cached: '读取网页',
  file_read: '读取文件', file_read_between: '读取文件',
  file_write: '写入文件', file_append: '追加内容', file_replace: '修改文件',
  file_list: '浏览目录', file_find: '搜索文件', file_tree: '查看目录',
  file_move: '移动文件', file_delete: '删除文件', file_batch: '批量操作',
  shell_run: '执行命令', ps_run: '执行脚本', delegate_agent: '委派子Agent',
  memory_add: '记录偏好', memory_remove: '更新记忆', lesson_capture: '沉淀经验', growth_record: '角色成长',
  ask_user: '询问用户', update_plan: '更新计划',
}

export const TaskActivity = memo(function TaskActivity({ items, onOpenResource, onContextResource }: TaskActivityProps) {
  const tools = items.filter(isToolResult)
  const running = tools.some((tool) => tool.status === 'in_progress')
  const failed = tools.some((tool) => tool.toolError)
  const cancelled = tools.some((tool) => tool.status === 'cancelled')
  const files = [...new Set(tools.flatMap((tool) => tool.toolPath ? [tool.toolPath] : []))]

  return <article className="task-activity-message">
    <div className="task-activity-stack">
      <div className={`task-activity ${running ? 'running' : ''}`}>
        <div className="task-activity-header">
          <span className="task-activity-icon">{running ? <LoaderCircle className="spin" size={14} /> : failed ? <AlertTriangle size={14} color="#d97706" /> : cancelled ? <Square size={13} color="#64748b" /> : <CheckCircle2 size={14} color="#16a34a" />}</span>
          <span className="task-activity-copy"><strong>{running ? '执行中' : failed ? '已完成，部分步骤未成功' : cancelled ? '已停止' : '完成'} · {tools.length} 步</strong></span>
        </div>
        <div className="task-activity-body">
          {tools.map((tool) => <ToolEntry key={tool.id} item={tool} onOpenResource={onOpenResource} onContextResource={onContextResource} />)}
        </div>
      </div>
      {!running && files.length ? <ArtifactSummary files={files} onOpenResource={onOpenResource} onContextResource={onContextResource} /> : null}
    </div>
  </article>
})

function ToolEntry({ item, onOpenResource, onContextResource }: ToolEntryProps) {
  const [expanded, setExpanded] = useState(false)
  const running = item.status === 'in_progress'
  const summary = item.content.length > 120 ? `${item.content.slice(0, 120)}…` : item.content
  const isAgent = item.toolName === 'delegate_agent'
  const toolPath = item.toolPath

  return <div className={`tool-entry ${running ? 'running' : ''} ${item.toolError ? 'error' : ''} ${isAgent ? 'agent' : ''}`}>
    <button type="button" className="tool-narrative" aria-expanded={expanded} onClick={() => setExpanded((current) => !current)}>
      <span className="tool-phase-icon">{running ? <LoaderCircle className="spin" size={13} /> : item.toolError ? <AlertTriangle size={13} color="#a8a29e" /> : <CheckCircle2 size={13} color="#9ca3af" />}</span>
      <span className="tool-intent">{TOOL_INTENT[item.toolName] ?? item.toolName}</span>
      {item.skillIds?.length ? <span className="tool-skill-source" title={`Skill: ${item.skillIds.join(', ')}`}>via {item.skillIds[0]}{item.skillIds.length > 1 ? ` +${item.skillIds.length - 1}` : ''}</span> : null}
      {summary ? <span className="tool-summary">{summary}</span> : null}
      {isAgent && item.agentName ? <span className="tool-agent-badge">{item.agentName}</span> : null}
      <ChevronDown size={12} className={`tool-chevron ${expanded ? 'open' : ''}`} />
    </button>
    {expanded ? <div className="tool-technical">
      <code className="tool-call">{item.toolName}</code>
      {item.toolArguments ? <pre className="tool-arguments">{item.toolArguments}</pre> : null}
      {item.toolWorkdir ? <small className="tool-workdir">工作目录：{item.toolWorkdir}</small> : null}
      {item.content ? <pre className="tool-output">{item.content.length > 500 ? `${item.content.slice(0, 500)}\n…truncated` : item.content}</pre> : null}
      {item.durationMs ? <small className="tool-duration">耗时 {item.durationMs} ms</small> : null}
      {toolPath ? <button className="tool-open" onClick={() => onOpenResource(toolPath)} onContextMenu={(event) => { event.preventDefault(); onContextResource(event, toolPath) }}>打开文件</button> : null}
    </div> : null}
  </div>
}

function ArtifactSummary({ files, onOpenResource, onContextResource }: ArtifactSummaryProps) {
  return <section className="artifact-summary">
    <header><span><Files size={16} /></span><div><strong>已生成或修改 {files.length} 个文件</strong><small>可直接打开；右键查看更多操作</small></div></header>
    <div>{files.slice(0, 6).map((filePath) => <button key={filePath} onClick={() => onOpenResource(filePath)} onContextMenu={(event) => { event.preventDefault(); onContextResource(event, filePath) }}><span>{resourceFileName(filePath)}</span><small>{filePath}</small><em>打开</em></button>)}</div>
    {files.length > 6 ? <footer>另外 {files.length - 6} 个文件可在右侧“产物”页签查看</footer> : null}
  </section>
}
