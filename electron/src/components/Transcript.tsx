import { Bot, BotIcon, CheckCircle2, ChevronDown, FileText, Files, Globe2, LoaderCircle, RefreshCw, UserRound } from 'lucide-react'
import { memo, useEffect, useMemo, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { FileContextMenu, type ResourceMenuState } from './FileContextMenu'
import { PlanCard } from './PlanCard'
import type { UiMessage } from '../types'

interface Props {
  messages: UiMessage[]
  displayName: string
  onOpenPath: (path: string) => void
  onError?: (message: string) => void
}

type TranscriptBlock =
  | { kind: 'message'; message: UiMessage }
  | { kind: 'activity'; id: string; messages: UiMessage[] }

const MarkdownBody = memo(function MarkdownBody({ content, onOpenResource, onContextResource }: { content: string; onOpenResource?: (target: string) => void; onContextResource?: (event: React.MouseEvent, target: string) => void }) {
  return <ReactMarkdown remarkPlugins={[remarkGfm]} components={{
    a: ({ href = '', children }) => <a href={href} onClick={(event) => { if (onOpenResource) { event.preventDefault(); onOpenResource(href) } }} onContextMenu={(event) => { if (onContextResource) { event.preventDefault(); onContextResource(event, href) } }}>{children}</a>,
    code: ({ children, className }) => {
      const value = String(children).replace(/\n$/, '')
      const resource = !className && (/^[A-Za-z]:[\\/].+/.test(value) || /^https?:\/\//i.test(value))
      return resource ? <button className="inline-resource" onClick={() => onOpenResource?.(value)} onContextMenu={(event) => { event.preventDefault(); onContextResource?.(event, value) }}><FileText size={12} />{value}</button> : <code className={className}>{children}</code>
    },
  }}>{content}</ReactMarkdown>
})

export function Transcript({ messages, displayName, onOpenPath, onError }: Props) {
  const transcriptRef = useRef<HTMLElement>(null)
  const stickToBottomRef = useRef(true)
  const [resourceMenu, setResourceMenu] = useState<ResourceMenuState | null>(null)
  const blocks = useMemo(() => buildBlocks(messages), [messages])
  useEffect(() => {
    const transcript = transcriptRef.current
    if (transcript && stickToBottomRef.current) transcript.scrollTop = transcript.scrollHeight
  }, [messages])
  const handleScroll = () => {
    const transcript = transcriptRef.current
    if (!transcript) return
    stickToBottomRef.current = transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight < 72
  }
  const openResource = (target: string) => {
    if (/^https?:\/\//i.test(target)) void window.ranparty.pathAction('open', target).catch((error) => onError?.(String(error)))
    else onOpenPath(normalizeFileTarget(target))
  }
  const contextResource = (event: React.MouseEvent, target: string) => setResourceMenu({ target: normalizeFileTarget(target), x: event.clientX, y: event.clientY })

  return (
    <main ref={transcriptRef} className="transcript" aria-live="polite" onScroll={handleScroll}>
      <div className="transcript-inner">
        {messages.length === 0 ? <EmptyState displayName={displayName} /> : null}
        {blocks.map((block) => block.kind === 'activity'
          ? <TaskActivity key={block.id} messages={block.messages} displayName={displayName} onOpenResource={openResource} onContextResource={contextResource} />
          : <MessageBlock key={block.message.id} message={block.message} displayName={displayName} onOpenResource={openResource} onContextResource={contextResource} />)}
      </div>
      {resourceMenu ? <FileContextMenu menu={resourceMenu} onClose={() => setResourceMenu(null)} onError={onError} /> : null}
    </main>
  )
}

function buildBlocks(messages: UiMessage[]): TranscriptBlock[] {
  const blocks: TranscriptBlock[] = []
  let activity: UiMessage[] = []
  const flush = () => {
    if (!activity.length) return
    blocks.push({ kind: 'activity', id: `activity_${activity[0].id}`, messages: activity })
    activity = []
  }
  for (const message of messages) {
    if (message.role === 'tool' && message.toolName === 'update_plan') { flush(); blocks.push({ kind: 'message', message }); continue }
    if (message.role === 'assistant' && message.planUpdate) { flush(); blocks.push({ kind: 'message', message }); continue }
    if (message.role === 'tool' || (message.role === 'assistant' && message.hasToolCalls)) { activity.push(message); continue }
    if (message.role === 'assistant' && activity.length) {
      blocks.push({ kind: 'message', message })
      flush()
      continue
    }
    flush()
    blocks.push({ kind: 'message', message })
  }
  flush()
  return blocks
}

function MessageBlock({ message, displayName, onOpenResource, onContextResource }: { message: UiMessage; displayName: string; onOpenResource: (target: string) => void; onContextResource: (event: React.MouseEvent, target: string) => void }) {
  if (message.role === 'system') return <SystemNotice content={message.content} />
  if (message.role === 'tool' && message.plan) return <PlanCard plan={message.plan} explanation={message.planExplanation} />
  if (message.role === 'tool') return null
  const isUser = message.role === 'user'
  return <article className={`message ${isUser ? 'user-message' : 'assistant-message'} ${message.error ? 'message-error' : ''}`}>
    <div className={`avatar ${isUser ? 'user-avatar' : 'assistant-avatar'}`}>{isUser ? <UserRound size={17} /> : <Bot size={18} />}</div>
    <div className="message-content">
      {!isUser ? <div className="message-meta"><strong>{displayName}</strong>{message.streaming ? <span className="generating"><LoaderCircle size={13} />正在生成</span> : null}</div> : null}
      {message.reasoning ? <details className="reasoning"><summary>思考过程</summary><p>{message.reasoning}</p></details> : null}
      {message.images?.length ? <div className="message-images">{message.images.map((image, index) => <img className="message-image" key={`${message.id}-${index}`} src={image} alt={`用户附件 ${index + 1}`} />)}</div> : null}
      <div className="markdown-body"><MarkdownBody content={message.content || (message.streaming ? ' ' : '（空回复）')} onOpenResource={onOpenResource} onContextResource={onContextResource} /></div>
      {message.usageIn || message.usageOut ? <div className="usage-line">{message.model} · 输入 {message.usageIn ?? 0} · 输出 {message.usageOut ?? 0}</div> : null}
    </div>
  </article>
}

function TaskActivity({ messages, displayName, onOpenResource, onContextResource }: { messages: UiMessage[]; displayName: string; onOpenResource: (target: string) => void; onContextResource: (event: React.MouseEvent, target: string) => void }) {
  const tools = messages.filter((message) => message.role === 'tool')
  const running = messages.some((message) => message.streaming)
  const failed = tools.some((message) => message.toolError)
  const agents = [...new Set(tools.map((message) => message.agentName).filter(Boolean))]
  const files = [...new Set(tools.map((message) => message.toolPath).filter((path): path is string => Boolean(path)))]
  const lead = messages.filter((message) => message.role === 'assistant' && message.content.trim()).map((message) => message.content.trim()).join('\n\n')
  const title = running ? '正在执行任务步骤' : failed ? '任务步骤完成，部分操作失败' : '已完成任务步骤'
  const summary = [`${tools.length} 次工具调用`, agents.length ? `${agents.length} 个子 Agent` : '', files.length ? `${files.length} 个文件变更` : ''].filter(Boolean).join(' · ')
  return <article className="task-activity-message">
    <div className="task-activity-stack">
      <div className="task-author"><strong>{displayName}</strong><span>AI 执行记录</span></div>
      {lead ? <div className="task-lead markdown-body"><MarkdownBody content={lead} onOpenResource={onOpenResource} onContextResource={onContextResource} /></div> : null}
      <details className={`task-activity ${running ? 'running' : ''}`} open={running || undefined}>
        <summary><span className="task-activity-icon">{running ? <LoaderCircle className="spin" size={15} /> : <CheckCircle2 size={15} />}</span><span className="task-activity-copy"><strong>{title}</strong><small>{summary}</small></span><ChevronDown className="task-activity-chevron" size={16} /></summary>
        <div className="task-activity-body">
          {agents.length ? <div className="task-agents"><BotIcon size={14} /><span>协作 Agent：{agents.join('、')}</span></div> : null}
          {tools.map((message) => <ToolRow key={message.id} message={message} onOpenResource={onOpenResource} onContextResource={onContextResource} />)}
        </div>
      </details>
      {!running && files.length ? <ArtifactSummary files={files} onOpenResource={onOpenResource} onContextResource={onContextResource} /> : null}
    </div>
  </article>
}

function ArtifactSummary({ files, onOpenResource, onContextResource }: { files: string[]; onOpenResource: (target: string) => void; onContextResource: (event: React.MouseEvent, target: string) => void }) {
  return <section className="artifact-summary"><header><span><Files size={16} /></span><div><strong>已生成或修改 {files.length} 个文件</strong><small>可直接打开；右键查看更多操作</small></div></header><div>{files.slice(0, 6).map((path) => <button key={path} onClick={() => onOpenResource(path)} onContextMenu={(event) => { event.preventDefault(); onContextResource(event, path) }}><span>{fileName(path)}</span><small>{path}</small><em>打开</em></button>)}</div>{files.length > 6 ? <footer>另外 {files.length - 6} 个文件可在右侧“产物”页签查看</footer> : null}</section>
}

function SystemNotice({ content }: { content: string }) { return <div className="system-notice" role="status"><RefreshCw size={13} /><span>{content}</span></div> }

function ToolRow({ message, onOpenResource, onContextResource }: { message: UiMessage; onOpenResource: (target: string) => void; onContextResource: (event: React.MouseEvent, target: string) => void }) {
  const isWeb = message.toolName === 'web_search' || message.toolName === 'web_fetch'
  const isAgent = message.toolName === 'delegate_agent'
  const label = isAgent ? `调用子 Agent · ${message.agentName || agentFromArguments(message.toolArguments)}` : message.toolName === 'web_search' ? '联网搜索' : message.toolName === 'web_fetch' ? '读取网页' : toolLabel(message.toolName)
  return <div className={`tool-row compact ${message.toolError ? 'error' : ''}`}>
    {isAgent ? <BotIcon size={19} /> : isWeb ? <Globe2 size={19} /> : <FileText size={19} />}
    <div className="tool-copy"><strong>{label}</strong><span>{toolSummary(message)}</span></div>
    {!message.streaming ? <span className="tool-status"><CheckCircle2 size={14} />{message.toolError ? '失败' : '已完成'}</span> : <LoaderCircle className="spin" size={16} />}
    {message.toolPath ? <button onClick={() => onOpenResource(message.toolPath!)} onContextMenu={(event) => { event.preventDefault(); onContextResource(event, message.toolPath!) }}>打开</button> : null}
  </div>
}

function agentFromArguments(value = '') { try { return String(JSON.parse(value).profileName || '未命名 Agent') } catch { return '未命名 Agent' } }
function toolSummary(message: UiMessage) { if (message.toolName === 'delegate_agent') { try { return String(JSON.parse(message.toolArguments || '{}').task || message.content) } catch { return message.content } } return message.toolArguments || message.content }
function toolLabel(name = '') { return ({ file_write: '写入文件', file_append: '追加文件', file_replace: '修改文件', file_move: '移动文件', file_read: '读取文件', ps_run: '运行 PowerShell', shell_run: '运行命令' } as Record<string, string>)[name] || name || '工具' }
function normalizeFileTarget(target: string) { try { return target.startsWith('file://') ? decodeURIComponent(new URL(target).pathname).replace(/^\/([A-Za-z]:)/, '$1') : target } catch { return target } }
function fileName(path: string) { return path.split(/[\\/]/).filter(Boolean).at(-1) ?? path }

function EmptyState({ displayName }: { displayName: string }) { return <div className="empty-state"><span className="empty-mark">RP</span><h2>从这里开始协作</h2><p>{displayName} 可以读取当前工作区、整理本地资料，并在你确认后执行工具。</p></div> }
