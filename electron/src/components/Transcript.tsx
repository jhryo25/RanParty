import { Bot, BotIcon, CheckCircle2, ChevronDown, FileText, Files, Globe2, LoaderCircle, RefreshCw, UserRound } from 'lucide-react'
import { memo, useEffect, useMemo, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { FileContextMenu, type ResourceMenuState } from './FileContextMenu'
import { PlanCard } from './PlanCard'
import type { ThreadItem } from '../types'
import {
  isAssistantMessage,
  isContextCompaction,
  isError,
  isPlanStep,
  isSystemNotice,
  isToolResult,
  isUserMessage,
} from '../types'

interface Props {
  items: ThreadItem[]
  displayName: string
  onOpenPath: (path: string) => void
  onError?: (message: string) => void
}

type TranscriptBlock =
  | { kind: 'message'; item: ThreadItem }
  | { kind: 'activity'; id: string; items: ThreadItem[] }

const MarkdownBody = memo(function MarkdownBody({ content, onOpenResource, onContextResource }: { content: string; onOpenResource?: (target: string) => void; onContextResource?: (event: React.MouseEvent, target: string) => void }) {
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

export function Transcript({ items, displayName, onOpenPath, onError }: Props) {
  const transcriptRef = useRef<HTMLElement>(null)
  const stickToBottomRef = useRef(true)
  const [resourceMenu, setResourceMenu] = useState<ResourceMenuState | null>(null)
  const blocks = useMemo(() => buildBlocks(items), [items])

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
          ? <TaskActivity_ key={block.id} items={block.items} displayName={displayName} onOpenResource={openResource} onContextResource={contextResource} />
          : <ItemBlock_ key={block.item.id} item={block.item} displayName={displayName} onOpenResource={openResource} onContextResource={contextResource} />)}
      </div>
      {resourceMenu ? <FileContextMenu menu={resourceMenu} onClose={() => setResourceMenu(null)} onError={onError} /> : null}
    </main>
  )
}

/** 将 ThreadItem[] 分组为 message/activity blocks */
function buildBlocks(items: ThreadItem[]): TranscriptBlock[] {
  const blocks: TranscriptBlock[] = []
  let activity: ThreadItem[] = []

  const flush = () => {
    if (!activity.length) return
    blocks.push({ kind: 'activity', id: `activity_${activity[0].id}`, items: activity })
    activity = []
  }

  for (const item of items) {
    if (isToolResult(item)) { activity.push(item); continue }
    if (isAssistantMessage(item) && item.streaming === false && activity.length) {
      blocks.push({ kind: 'message', item })
      flush()
      continue
    }
    flush()
    blocks.push({ kind: 'message', item })
  }
  flush()
  return blocks
}

// ============================================================
// ItemBlock — 按 item.type 分发渲染
// ============================================================

function ItemBlock_({ item, displayName, onOpenResource, onContextResource }: {
  item: ThreadItem
  displayName: string
  onOpenResource: (target: string) => void
  onContextResource: (event: React.MouseEvent, target: string) => void
}) {
  if (isSystemNotice(item)) return <SystemNotice content={item.content} />
  if (isPlanStep(item)) return <PlanCard plan={item.steps} explanation={item.explanation} />
  if (isToolResult(item)) return null
  if (isContextCompaction(item)) return <SystemNotice content={`上下文已压缩 (${item.tokensBefore} → ${item.tokensAfter} Token)`} />

  if (isUserMessage(item)) {
    return <UserBlock item={item} displayName={displayName} />
  }

  if (isAssistantMessage(item)) {
    return <AssistantBlock item={item} displayName={displayName} />
  }

  if (isError(item)) {
    return <SystemNotice content={item.message} />
  }

  return null
}

const ItemBlock = memo(ItemBlock_)

// ============================================================
// UserBlock
// ============================================================

function UserBlock({ item, displayName: _displayName }: { item: import('../types').UserMessageItem; displayName: string }) {
  return <article className="message user-message">
    <div className="avatar user-avatar"><UserRound size={17} /></div>
    <div className="message-content">
      {item.images?.length ? <div className="message-images">{item.images.map((img: string, i: number) => <img className="message-image" key={`${item.id}-${i}`} src={img} alt={`附件 ${i + 1}`} />)}</div> : null}
      <div className="markdown-body"><MarkdownBody content={item.content} /></div>
    </div>
  </article>
}

// ============================================================
// AssistantBlock
// ============================================================

function AssistantBlock({ item, displayName }: { item: import('../types').AssistantMessageItem; displayName: string }) {
  return <article className={`message assistant-message ${item.error ? 'message-error' : ''}`}>
    <div className="avatar assistant-avatar"><Bot size={18} /></div>
    <div className="message-content">
      <div className="message-meta">
        <strong>{displayName}</strong>
        {item.streaming ? <span className="generating"><LoaderCircle size={13} />正在生成</span> : null}
      </div>
      {item.reasoning ? <details className="reasoning"><summary>思考过程</summary><p>{item.reasoning}</p></details> : null}
      <div className="markdown-body"><MarkdownBody content={item.content || (item.streaming ? ' ' : '（空回复）')} /></div>
      {item.usageIn || item.usageOut ? <div className="usage-line">{item.model} · 输入 {item.usageIn ?? 0} · 输出 {item.usageOut ?? 0}</div> : null}
    </div>
  </article>
}

// ============================================================
// TaskActivity — 工具执行组
// ============================================================

function TaskActivity_({ items, displayName, onOpenResource, onContextResource }: {
  items: ThreadItem[]
  displayName: string
  onOpenResource: (target: string) => void
  onContextResource: (event: React.MouseEvent, target: string) => void
}) {
  const tools = items.filter(isToolResult)
  const running = tools.some((t) => t.status === 'in_progress')
  const failed = tools.some((t) => t.toolError)
  const agents = [...new Set(tools.map((t) => t.agentName).filter(Boolean))]
  const files = [...new Set(tools.map((t) => t.toolPath).filter((p): p is string => Boolean(p)))]

  const lead = items
    .filter(isAssistantMessage)
    .map((t) => t.content.trim())
    .filter(Boolean)
    .join('\n\n')

  const title = running ? '正在执行任务步骤' : failed ? '任务步骤完成，部分操作失败' : '已完成任务步骤'
  const summary = [`${tools.length} 次工具调用`, agents.length ? `${agents.length} 个子 Agent` : '', files.length ? `${files.length} 个文件变更` : ''].filter(Boolean).join(' · ')

  return <article className="task-activity-message">
    <div className="task-activity-stack">
      <div className="task-author"><strong>{displayName}</strong><span>AI 执行记录</span></div>
      {lead ? <div className="task-lead markdown-body"><MarkdownBody content={lead} onOpenResource={onOpenResource} onContextResource={onContextResource} /></div> : null}
      <details className={`task-activity ${running ? 'running' : ''}`} open={running || undefined}>
        <summary>
          <span className="task-activity-icon">{running ? <LoaderCircle className="spin" size={15} /> : <CheckCircle2 size={15} />}</span>
          <span className="task-activity-copy"><strong>{title}</strong><small>{summary}</small></span>
          <ChevronDown className="task-activity-chevron" size={16} />
        </summary>
        <div className="task-activity-body">
          {agents.length ? <div className="task-agents"><BotIcon size={14} /><span>协作 Agent：{agents.join('、')}</span></div> : null}
          {tools.map((t) => <ToolRow_ key={t.id} item={t} onOpenResource={onOpenResource} onContextResource={onContextResource} />)}
        </div>
      </details>
      {!running && files.length ? <ArtifactSummary_ files={files} onOpenResource={onOpenResource} onContextResource={onContextResource} /> : null}
    </div>
  </article>
}

const TaskActivity = memo(TaskActivity_)

// ============================================================
// ArtifactSummary
// ============================================================

function ArtifactSummary_({ files, onOpenResource, onContextResource }: { files: string[]; onOpenResource: (target: string) => void; onContextResource: (event: React.MouseEvent, target: string) => void }) {
  return <section className="artifact-summary">
    <header><span><Files size={16} /></span><div><strong>已生成或修改 {files.length} 个文件</strong><small>可直接打开；右键查看更多操作</small></div></header>
    <div>{files.slice(0, 6).map((path) => <button key={path} onClick={() => onOpenResource(path)} onContextMenu={(event) => { event.preventDefault(); onContextResource(event, path) }}><span>{fileName(path)}</span><small>{path}</small><em>打开</em></button>)}</div>
    {files.length > 6 ? <footer>另外 {files.length - 6} 个文件可在右侧"产物"页签查看</footer> : null}
  </section>
}

const ArtifactSummary = memo(ArtifactSummary_)

// ============================================================
// ToolRow
// ============================================================

function ToolRow_({ item, onOpenResource, onContextResource }: { item: import('../types').ToolResultItem; onOpenResource: (target: string) => void; onContextResource: (event: React.MouseEvent, target: string) => void }) {
  const isWeb = item.toolName === 'web_search' || item.toolName === 'web_fetch'
  const isAgent = item.toolName === 'delegate_agent'
  const label = isAgent ? `调用子 Agent · ${item.agentName || '未知 Agent'}` : item.toolName === 'web_search' ? '联网搜索' : item.toolName === 'web_fetch' ? '读取网页' : toolLabel(item.toolName)

  return <div className={`tool-row compact ${item.toolError ? 'error' : ''}`}>
    {isAgent ? <BotIcon size={19} /> : isWeb ? <Globe2 size={19} /> : <FileText size={19} />}
    <div className="tool-copy"><strong>{label}</strong><span>{toolSummary(item)}</span></div>
    {item.status !== 'in_progress' ? <span className="tool-status"><CheckCircle2 size={14} />{item.toolError ? '失败' : '已完成'}</span> : <LoaderCircle className="spin" size={16} />}
    {item.toolPath ? <button onClick={() => onOpenResource(item.toolPath!)} onContextMenu={(event) => { event.preventDefault(); onContextResource(event, item.toolPath!) }}>打开</button> : null}
  </div>
}

const ToolRow = memo(ToolRow_)

// ============================================================
// SystemNotice / EmptyState / 工具函数
// ============================================================

function SystemNotice({ content }: { content: string }) {
  return <div className="system-notice" role="status"><RefreshCw size={13} /><span>{content}</span></div>
}

function EmptyState({ displayName }: { displayName: string }) {
  return <div className="empty-state"><span className="empty-mark">RP</span><h2>从这里开始协作</h2><p>{displayName} 可以读取当前工作区、整理本地资料，并在你确认后执行工具。</p></div>
}

function toolSummary(item: import('../types').ToolResultItem) {
  if (item.toolName === 'delegate_agent') {
    try { return String(JSON.parse('{}').task || item.content) }
    catch { return item.content }
  }
  return item.content
}

function toolLabel(name = '') {
  return ({ file_write: '写入文件', file_append: '追加文件', file_replace: '修改文件', file_move: '移动文件', file_read: '读取文件', ps_run: '运行 PowerShell', shell_run: '运行命令' } as Record<string, string>)[name] || name || '工具'
}

function normalizeFileTarget(target: string) {
  try { return target.startsWith('file://') ? decodeURIComponent(new URL(target).pathname).replace(/^\/([A-Za-z]:)/, '$1') : target }
  catch { return target }
}

function fileName(path: string) { return path.split(/[\\/]/).filter(Boolean).at(-1) ?? path }
