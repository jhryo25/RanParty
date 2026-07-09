import { AlertTriangle, ArrowDown, Bot, BotIcon, CheckCircle2, ChevronDown, FileText, Files, Globe2, LoaderCircle, RefreshCw, UserRound } from 'lucide-react'
import { memo, useEffect, useMemo, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { FileContextMenu, type ResourceMenuState } from './FileContextMenu'
import { PlanCard } from './PlanCard'
import type { AssistantMessageItem, ThreadItem, ToolResultItem, UserMessageItem } from '../types'
import {
  isAssistantMessage,
  isContextCompaction,
  isError,
  isPlanStep,
  isSystemNotice,
  isToolCall,
  isToolResult,
  isUserMessage,
} from '../types'

interface Props {
  items: ThreadItem[]
  displayName: string
  planSinceIndex?: number
  onOpenPath: (path: string) => void
  onError?: (message: string) => void
  planMode?: boolean
  onAcceptPlan?: (planText: string) => void
  onRevisePlan?: (planText: string) => void
  onCancelPlan?: () => void
}

type TranscriptBlock =
  | { kind: 'message'; item: ThreadItem }
  | { kind: 'activity'; id: string; items: ThreadItem[] }

const MarkdownBody = memo(function MarkdownBody({
  content,
  onOpenResource,
  onContextResource,
}: {
  content: string
  onOpenResource?: (target: string) => void
  onContextResource?: (event: React.MouseEvent, target: string) => void
}) {
  return <ReactMarkdown remarkPlugins={[remarkGfm]} components={{
    a: ({ href = '', children }) => {
      const safeHref = (/^https?:\/\//i.test(href) || /^mailto:/i.test(href) || /^\//.test(href) || /^[a-z]:[\\/]/i.test(href)) ? href : '#'
      return <a href={safeHref} onClick={(event) => { if (onOpenResource && safeHref !== '#') { event.preventDefault(); onOpenResource(href) } }} onContextMenu={(event) => { if (onContextResource && safeHref !== '#') { event.preventDefault(); onContextResource(event, href) } }}>{children}</a>
    },
    code: ({ children, className }) => {
      const value = String(children).replace(/\n$/, '')
      const resource = !className && (/^[A-Za-z]:[\\/].+/.test(value) || /^https?:\/\//i.test(value))
      return resource ? <button className="inline-resource" onClick={() => onOpenResource?.(value)} onContextMenu={(event) => { event.preventDefault(); onContextResource?.(event, value) }}><FileText size={12} />{value}</button> : <code className={className}>{children}</code>
    },
  }}>{content}</ReactMarkdown>
})

export function Transcript({
  items,
  displayName,
  onOpenPath,
  onError,
  planMode,
  planSinceIndex,
  onAcceptPlan,
  onRevisePlan,
  onCancelPlan,
}: Props) {
  const transcriptRef = useRef<HTMLElement>(null)
  const stickToBottomRef = useRef(true)
  const [resourceMenu, setResourceMenu] = useState<ResourceMenuState | null>(null)
  const [showJumpToLatest, setShowJumpToLatest] = useState(false)
  const blocks = useMemo(() => buildBlocks(items), [items])
  const actionablePlanId = useMemo(() => {
    if (!planMode) return ''
    const candidate = [...items].reverse().find((item, idx) =>
      // 仅匹配 Plan 模式激活之后到达的消息（索引 >= planSinceIndex）
      (isPlanStep(item) && item.steps.length > 0) ||
      (isAssistantMessage(item) && item.status === 'completed' && item.content.trim() && (items.length - 1 - idx) >= (planSinceIndex ?? 0))
    )
    return candidate?.id ?? ''
  }, [items, planMode, planSinceIndex])

  useEffect(() => {
    const transcript = transcriptRef.current
    if (!transcript) return
    if (stickToBottomRef.current) {
      transcript.scrollTop = transcript.scrollHeight
      setShowJumpToLatest(false)
    } else {
      setShowJumpToLatest(true)
    }
  }, [items])

  const handleScroll = () => {
    const transcript = transcriptRef.current
    if (!transcript) return
    const atBottom = transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight < 72
    stickToBottomRef.current = atBottom
    setShowJumpToLatest(!atBottom)
  }

  const jumpToLatest = () => {
    const transcript = transcriptRef.current
    if (!transcript) return
    stickToBottomRef.current = true
    transcript.scrollTo({ top: transcript.scrollHeight, behavior: 'smooth' })
    setShowJumpToLatest(false)
  }

  const openResource = (target: string) => {
    if (/^https?:\/\//i.test(target)) void window.ranparty.pathAction('open', target).catch((error) => onError?.(String(error)))
    else onOpenPath(normalizeFileTarget(target))
  }

  const contextResource = (event: React.MouseEvent, target: string) =>
    setResourceMenu({ target: normalizeFileTarget(target), x: event.clientX, y: event.clientY })

  return (
    <main ref={transcriptRef} className="transcript" aria-live="polite" onScroll={handleScroll}>
      <div className="transcript-inner">
        {items.length === 0 ? <EmptyState displayName={displayName} /> : null}
        {blocks.map((block) => block.kind === 'activity'
          ? <TaskActivity key={block.id} items={block.items} onOpenResource={openResource} onContextResource={contextResource} />
          : <ItemBlock
              key={block.item.id}
              item={block.item}
              displayName={displayName}
              onOpenResource={openResource}
              onContextResource={contextResource}
              actionablePlan={block.item.id === actionablePlanId}
              onAcceptPlan={onAcceptPlan}
              onRevisePlan={onRevisePlan}
              onCancelPlan={onCancelPlan}
            />)}
      </div>
      {showJumpToLatest ? <button type="button" className="scroll-latest-button" onClick={jumpToLatest} aria-label="查看最新消息"><ArrowDown size={14} />查看最新</button> : null}
      {resourceMenu ? <FileContextMenu menu={resourceMenu} onClose={() => setResourceMenu(null)} onError={onError} /> : null}
    </main>
  )
}

function buildBlocks(items: ThreadItem[]): TranscriptBlock[] {
  const blocks: TranscriptBlock[] = []
  let activity: ThreadItem[] = []

  const flush = () => {
    if (!activity.length) return
    blocks.push({ kind: 'activity', id: `activity_${activity[0].id}`, items: activity })
    activity = []
  }

  for (const item of items) {
    if (isToolResult(item) || isToolCall(item)) { activity.push(item); continue }
    if (isAssistantMessage(item) && !item.content.trim() && item.hasToolCalls) continue
    if (isAssistantMessage(item) && !item.content.trim() && activity.length) continue
    flush()
    blocks.push({ kind: 'message', item })
  }
  flush()
  return blocks
}

function ItemBlock({
  item,
  displayName,
  onOpenResource,
  onContextResource,
  actionablePlan,
  onAcceptPlan,
  onRevisePlan,
  onCancelPlan,
}: {
  item: ThreadItem
  displayName: string
  onOpenResource: (target: string) => void
  onContextResource: (event: React.MouseEvent, target: string) => void
  actionablePlan?: boolean
  onAcceptPlan?: (planText: string) => void
  onRevisePlan?: (planText: string) => void
  onCancelPlan?: () => void
}) {
  if (isSystemNotice(item)) return <SystemNotice content={item.content} />
  if (isPlanStep(item)) return <PlanCard plan={item.steps} explanation={item.explanation} actionable={actionablePlan} onAccept={onAcceptPlan} onRevise={onRevisePlan} onCancel={onCancelPlan} />
  if (isToolResult(item)) return null
  if (isContextCompaction(item)) return <SystemNotice content={`上下文已压缩 (${item.tokensBefore} → ${item.tokensAfter} Token)`} />
  if (isUserMessage(item)) return <UserBlock item={item} />
  if (isAssistantMessage(item)) return <AssistantBlock item={item} displayName={displayName} actionablePlan={actionablePlan} onAcceptPlan={onAcceptPlan} onRevisePlan={onRevisePlan} onCancelPlan={onCancelPlan} />
  if (isError(item)) return <SystemNotice content={item.message} />
  return null
}

function UserBlock({ item }: { item: UserMessageItem }) {
  return <article className="message user-message">
    <div className="avatar user-avatar"><UserRound size={17} /></div>
    <div className="message-content">
      {item.images?.length ? <div className="message-images">{item.images.map((img, i) => <img className="message-image" key={`${item.id}-${i}`} src={img} alt={`附件 ${i + 1}`} />)}</div> : null}
      <div className="markdown-body"><MarkdownBody content={item.content} /></div>
    </div>
  </article>
}

function AssistantBlock({
  item,
  displayName,
  actionablePlan,
  onAcceptPlan,
  onRevisePlan,
  onCancelPlan,
}: {
  item: AssistantMessageItem
  displayName: string
  actionablePlan?: boolean
  onAcceptPlan?: (planText: string) => void
  onRevisePlan?: (planText: string) => void
  onCancelPlan?: () => void
}) {
  if (!item.streaming && !item.content.trim() && item.hasToolCalls) return null
  const empty = !item.streaming && !item.content.trim()
  return <article className={`message assistant-message ${item.error ? 'message-error' : ''}`}>
    <div className="avatar assistant-avatar"><Bot size={18} /></div>
    <div className="message-content">
      <div className="message-meta">
        <strong>{displayName}</strong>
        {item.streaming ? <span className="generating"><LoaderCircle size={13} />正在生成</span> : null}
      </div>
      {/* Thinking disclosure: live bottom-pin while streaming, collapsible when done */}
      {item.reasoning ? (
        item.streaming ? (
          <div className="thinking-live">
            <div className="thinking-fade" />
            <div className="thinking-stream">{item.reasoning.slice(-500)}</div>
            <span className="thinking-timer"><LoaderCircle className="spin" size={11} />思考中</span>
          </div>
        ) : (
          <details className="thinking-done">
            <summary>已思考</summary>
            <p>{item.reasoning}</p>
          </details>
        )
      ) : null}
      <div className="markdown-body">{empty ? (!item.hasToolCalls ? null : <span className="empty-response">—</span>) : <MarkdownBody content={empty ? '' : item.content || ''} />}</div>
      {item.usageIn || item.usageOut ? <div className="usage-line">{item.model} · 输入 {item.usageIn ?? 0} · 输出 {item.usageOut ?? 0}</div> : null}
      {actionablePlan ? <div className="plan-actions inline-plan-actions">
        <button type="button" className="primary-button" onClick={() => onAcceptPlan?.(item.content)}>同意执行</button>
        <button type="button" className="outline-button" onClick={() => onRevisePlan?.(item.content)}>修改计划</button>
        <button type="button" className="ghost-button" onClick={onCancelPlan}>取消</button>
      </div> : null}
    </div>
  </article>
}

function TaskActivity({ items, onOpenResource, onContextResource }: {
  items: ThreadItem[]
  onOpenResource: (target: string) => void
  onContextResource: (event: React.MouseEvent, target: string) => void
}) {
  const tools = items.filter(isToolResult)
  const running = tools.some((t) => t.status === 'in_progress')
  const failed = tools.some((t) => t.toolError)
  const files = [...new Set(tools.map((t) => t.toolPath).filter((p): p is string => Boolean(p)))]

  return <article className="task-activity-message">
    <div className="task-activity-stack">
      <div className={`task-activity ${running ? 'running' : ''}`}>
        <div className="task-activity-header">
          <span className="task-activity-icon">{running ? <LoaderCircle className="spin" size={14} /> : failed ? <AlertTriangle size={14} color="#d97706" /> : <CheckCircle2 size={14} color="#16a34a" />}</span>
          <span className="task-activity-copy"><strong>{running ? '执行中' : failed ? '部分失败' : '完成'} · {tools.length} 步</strong></span>
        </div>
        <div className="task-activity-body">
          {tools.map((t) => <ToolEntry key={t.id} item={t} onOpenResource={onOpenResource} onContextResource={onContextResource} />)}
        </div>
      </div>
      {!running && files.length ? <ArtifactSummary files={files} onOpenResource={onOpenResource} onContextResource={onContextResource} /> : null}
    </div>
  </article>
}

const TOOL_INTENT: Record<string, string> = {
  web_search: '搜索资料', web_search_cached: '搜索资料', web_fetch: '读取网页', web_fetch_cached: '读取网页',
  file_read: '读取文件', file_read_between: '读取文件',
  file_write: '写入文件', file_append: '追加内容', file_replace: '修改文件',
  file_list: '浏览目录', file_find: '搜索文件', file_tree: '查看目录',
  file_move: '移动文件', file_delete: '删除文件', file_batch: '批量操作',
  shell_run: '执行命令', ps_run: '执行脚本',
  delegate_agent: '委派子Agent',
  memory_add: '记录偏好', memory_remove: '更新记忆', lesson_capture: '沉淀经验', growth_record: '角色成长',
  ask_user: '询问用户', update_plan: '更新计划',
}

function toolIntent(name: string): string { return TOOL_INTENT[name] ?? name }

function ToolEntry({ item, onOpenResource, onContextResource }: { item: ToolResultItem; onOpenResource: (target: string) => void; onContextResource: (event: React.MouseEvent, target: string) => void }) {
  const [expanded, setExpanded] = useState(false)
  const running = item.status === 'in_progress'
  const summary = (item.content ?? '').length > 120 ? (item.content ?? '').slice(0, 120) + '…' : (item.content ?? '')
  const isAgent = item.toolName === 'delegate_agent'

  return <div className={`tool-entry ${running ? 'running' : ''} ${item.toolError ? 'error' : ''} ${isAgent ? 'agent' : ''}`}>
    <div className="tool-narrative" onClick={() => setExpanded(!expanded)}>
      <span className="tool-phase-icon">
        {running ? <LoaderCircle className="spin" size={13} /> : item.toolError ? <AlertTriangle size={13} color="#dc2626" /> : <CheckCircle2 size={13} color="#9ca3af" />}
      </span>
      <span className="tool-intent">{toolIntent(item.toolName)}</span>
      {summary ? <span className="tool-summary">{summary}</span> : null}
      {isAgent && item.agentName ? <span className="tool-agent-badge">{item.agentName}</span> : null}
      <ChevronDown size={12} className={`tool-chevron ${expanded ? 'open' : ''}`} />
    </div>
    {expanded && <div className="tool-technical">
      <code className="tool-call">{item.toolName}</code>
      {item.content ? <pre className="tool-output">{item.content.length > 500 ? item.content.slice(0, 500) + '\n…truncated' : item.content}</pre> : null}
      {item.toolPath ? <button className="tool-open" onClick={() => onOpenResource(item.toolPath!)} onContextMenu={(e) => { e.preventDefault(); onContextResource(e, item.toolPath!) }}>打开文件</button> : null}
    </div>}
  </div>
}

function ArtifactSummary({ files, onOpenResource, onContextResource }: { files: string[]; onOpenResource: (target: string) => void; onContextResource: (event: React.MouseEvent, target: string) => void }) {
  return <section className="artifact-summary">
    <header><span><Files size={16} /></span><div><strong>已生成或修改 {files.length} 个文件</strong><small>可直接打开；右键查看更多操作</small></div></header>
    <div>{files.slice(0, 6).map((path) => <button key={path} onClick={() => onOpenResource(path)} onContextMenu={(event) => { event.preventDefault(); onContextResource(event, path) }}><span>{fileName(path)}</span><small>{path}</small><em>打开</em></button>)}</div>
    {files.length > 6 ? <footer>另外 {files.length - 6} 个文件可在右侧“产物”页签查看</footer> : null}
  </section>
}

function ToolRow({ item, onOpenResource, onContextResource }: { item: ToolResultItem; onOpenResource: (target: string) => void; onContextResource: (event: React.MouseEvent, target: string) => void }) {
  const isWeb = item.toolName === 'web_search' || item.toolName === 'web_fetch'
  const isAgent = item.toolName === 'delegate_agent'
  const label = isAgent ? `调用子 Agent · ${item.agentName || '未命名 Agent'}` : item.toolName === 'web_search' ? '联网搜索' : item.toolName === 'web_fetch' ? '读取网页' : toolLabel(item.toolName)

  return <div className={`tool-row compact ${item.toolError ? 'error' : ''}`}>
    {isAgent ? <BotIcon size={19} /> : isWeb ? <Globe2 size={19} /> : <FileText size={19} />}
    <div className="tool-copy"><strong>{label}</strong><span>{toolSummary(item)}</span></div>
    {item.status !== 'in_progress' ? <span className="tool-status"><CheckCircle2 size={14} />{item.toolError ? '失败' : '已完成'}</span> : <LoaderCircle className="spin" size={16} />}
    {item.toolPath ? <button onClick={() => onOpenResource(item.toolPath!)} onContextMenu={(event) => { event.preventDefault(); onContextResource(event, item.toolPath!) }}>打开</button> : null}
  </div>
}

function SystemNotice({ content }: { content: string }) {
  return <div className="system-notice" role="status"><RefreshCw size={13} /><span>{content}</span></div>
}

function EmptyState({ displayName }: { displayName: string }) {
  return <div className="empty-chat">
    <div className="empty-mark"><Bot size={24} /></div>
    <h2>和 {displayName} 开始一个任务</h2>
    <p>选择工作区、模型和需要注入的 Skill，然后直接描述你想完成的事。</p>
  </div>
}

function toolLabel(name: string) {
  if (name === 'file_batch') return '文件操作'
  if (name === 'shell_run') return '终端命令'
  if (name === 'ask_user') return '请求用户确认'
  if (name === 'update_plan') return '更新任务计划'
  return name || '工具'
}

function toolSummary(item: ToolResultItem) {
  if (item.status === 'in_progress') return '正在执行'
  const content = item.content.replace(/\s+/g, ' ').trim()
  if (item.toolPath) return item.toolPath
  return content.slice(0, 120) || (item.toolError ? '执行失败' : '执行完成')
}

function normalizeFileTarget(target: string) {
  return target.replace(/^file:\/\//i, '').replace(/\//g, '\\')
}

function fileName(path: string) {
  return path.split(/[\\/]/).filter(Boolean).at(-1) ?? path
}
