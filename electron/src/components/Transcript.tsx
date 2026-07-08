import { Bot, BotIcon, CheckCircle2, ChevronDown, FileText, Files, Globe2, LoaderCircle, RefreshCw, UserRound } from 'lucide-react'
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
  onAcceptPlan,
  onRevisePlan,
  onCancelPlan,
}: Props) {
  const transcriptRef = useRef<HTMLElement>(null)
  const stickToBottomRef = useRef(true)
  const [resourceMenu, setResourceMenu] = useState<ResourceMenuState | null>(null)
  const blocks = useMemo(() => buildBlocks(items), [items])
  const actionablePlanId = useMemo(() => {
    if (!planMode) return ''
    const candidate = [...items].reverse().find((item) =>
      (isAssistantMessage(item) && item.status === 'completed' && item.content.trim()) ||
      (isPlanStep(item) && item.steps.length > 0)
    )
    return candidate?.id ?? ''
  }, [items, planMode])

  useEffect(() => {
    const transcript = transcriptRef.current
    if (transcript && stickToBottomRef.current) transcript.scrollTop = transcript.scrollHeight
  }, [items])

  const handleScroll = () => {
    const transcript = transcriptRef.current
    if (!transcript) return
    stickToBottomRef.current = transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight < 72
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
      {item.reasoning && item.content.trim() ? <details className="reasoning"><summary>思考过程</summary><p>{item.reasoning}</p></details> : null}
      <div className="markdown-body"><MarkdownBody content={empty ? '模型没有返回可显示内容，请检查模型协议或重新发送。' : item.content || ' '} /></div>
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
  const agents = [...new Set(tools.map((t) => t.agentName).filter(Boolean))]
  const files = [...new Set(tools.map((t) => t.toolPath).filter((p): p is string => Boolean(p)))]

  const title = running ? '正在执行任务步骤' : failed ? '任务步骤完成，部分操作失败' : '已完成任务步骤'
  const summary = [`${tools.length} 次工具调用`, agents.length ? `${agents.length} 个子 Agent` : '', files.length ? `${files.length} 个文件变更` : ''].filter(Boolean).join(' · ')

  return <article className="task-activity-message">
    <div className="task-activity-stack">
      <details className={`task-activity ${running ? 'running' : ''}`} open={running || undefined}>
        <summary>
          <span className="task-activity-icon">{running ? <LoaderCircle className="spin" size={15} /> : <CheckCircle2 size={15} />}</span>
          <span className="task-activity-copy"><strong>{title}</strong><small>{summary}</small></span>
          <ChevronDown className="task-activity-chevron" size={16} />
        </summary>
        <div className="task-activity-body">
          {agents.length ? <div className="task-agents"><BotIcon size={14} /><span>协作 Agent：{agents.join('、')}</span></div> : null}
          {tools.map((t) => <ToolRow key={t.id} item={t} onOpenResource={onOpenResource} onContextResource={onContextResource} />)}
        </div>
      </details>
      {!running && files.length ? <ArtifactSummary files={files} onOpenResource={onOpenResource} onContextResource={onContextResource} /> : null}
    </div>
  </article>
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
