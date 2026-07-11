import { FileText } from 'lucide-react'
import { memo, type MouseEvent } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { safeResourceTarget } from './transcript-resource'

interface MarkdownBodyProps {
  content: string
  onOpenResource: (target: string) => void
  onContextResource: (event: MouseEvent, target: string) => void
}

export const MarkdownBody = memo(function MarkdownBody({ content, onOpenResource, onContextResource }: MarkdownBodyProps) {
  return <ReactMarkdown remarkPlugins={[remarkGfm]} components={{
    a: ({ href = '', children }) => {
      const safeHref = safeResourceTarget(href)
      return <a
        href={safeHref || '#'}
        aria-disabled={!safeHref}
        onClick={(event) => {
          event.preventDefault()
          if (safeHref) onOpenResource(safeHref)
        }}
        onContextMenu={(event) => {
          event.preventDefault()
          if (safeHref) onContextResource(event, safeHref)
        }}
      >{children}</a>
    },
    code: ({ children, className }) => {
      const value = String(children).replace(/\n$/, '')
      const resource = !className ? safeResourceTarget(value) : ''
      return resource
        ? <button className="inline-resource" onClick={() => onOpenResource(resource)} onContextMenu={(event) => { event.preventDefault(); onContextResource(event, resource) }}><FileText size={12} />{value}</button>
        : <code className={className}>{children}</code>
    },
  }}>{content}</ReactMarkdown>
})
