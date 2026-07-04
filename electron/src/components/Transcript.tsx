import { Bot, CheckCircle2, ChevronUp, FileText, LoaderCircle, UserRound } from 'lucide-react'
import { memo, useEffect, useRef } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { UiMessage } from '../types'

interface Props {
  messages: UiMessage[]
  displayName: string
  onOpenPath: (path: string) => void
}

const MarkdownBody = memo(function MarkdownBody({ content }: { content: string }) {
  return <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
})

export function Transcript({ messages, displayName, onOpenPath }: Props) {
  const transcriptRef = useRef<HTMLElement>(null)
  useEffect(() => {
    const transcript = transcriptRef.current
    if (transcript) transcript.scrollTop = transcript.scrollHeight
  }, [messages])

  return (
    <main ref={transcriptRef} className="transcript" aria-live="polite">
      <div className="transcript-inner">
        {messages.length === 0 ? <EmptyState displayName={displayName} /> : null}
        {messages.map((message) => {
          if (message.role === 'tool') return <ToolRow key={message.id} message={message} onOpenPath={onOpenPath} />
          const isUser = message.role === 'user'
          return (
            <article key={message.id} className={`message ${isUser ? 'user-message' : 'assistant-message'} ${message.error ? 'message-error' : ''}`}>
              <div className={`avatar ${isUser ? 'user-avatar' : 'assistant-avatar'}`}>
                {isUser ? <UserRound size={17} /> : <Bot size={18} />}
              </div>
              <div className="message-content">
                <div className="message-meta">
                  <strong>{isUser ? '你' : displayName}</strong>
                  {message.streaming ? <span className="generating"><LoaderCircle size={13} />正在生成</span> : null}
                </div>
                {message.reasoning ? <details className="reasoning"><summary>思考过程</summary><p>{message.reasoning}</p></details> : null}
                {message.images?.length ? <div className="message-images">{message.images.map((image, index) => <img className="message-image" key={`${message.id}-${index}`} src={image} alt={`用户附件 ${index + 1}`} />)}</div> : null}
                <div className="markdown-body"><MarkdownBody content={message.content || (message.streaming ? ' ' : '（空回复）')} /></div>
                {message.usageIn || message.usageOut ? (
                  <div className="usage-line">{message.model} · 输入 {message.usageIn ?? 0} · 输出 {message.usageOut ?? 0}</div>
                ) : null}
              </div>
            </article>
          )
        })}
      </div>
    </main>
  )
}

function ToolRow({ message, onOpenPath }: { message: UiMessage; onOpenPath: (path: string) => void }) {
  return (
    <article className={`tool-row ${message.toolError ? 'error' : ''}`}>
      <FileText size={22} />
      <div className="tool-copy">
        <strong>{message.toolName}</strong>
        <span>{message.toolArguments || message.content}</span>
      </div>
      {!message.streaming ? <span className="tool-status"><CheckCircle2 size={15} />{message.toolError ? '失败' : '已完成'}</span> : <LoaderCircle className="spin" size={17} />}
      {message.toolPath ? <button onClick={() => onOpenPath(message.toolPath!)}>查看文件</button> : null}
      <ChevronUp size={17} />
    </article>
  )
}

function EmptyState({ displayName }: { displayName: string }) {
  return (
    <div className="empty-state">
      <span className="empty-mark">RP</span>
      <h2>从这里开始协作</h2>
      <p>{displayName} 可以读取当前工作区、整理本地资料，并在你确认后执行工具。</p>
    </div>
  )
}
