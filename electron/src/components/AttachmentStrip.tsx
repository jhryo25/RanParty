import { FileText, X } from 'lucide-react'
import type { Attachment } from '../types'
import { isImageAttachment } from './composer-utils'

interface Props {
  attachments: Attachment[]
  onRemove: (index: number) => void
  className?: string
}

export function AttachmentStrip({ attachments, onRemove, className = '' }: Props) {
  if (!attachments.length) return null

  return <div className={`attachment-strip ${className}`.trim()} aria-label="已添加的附件">
    {attachments.map((attachment, index) => {
      const image = isImageAttachment(attachment)
      return <div
        className={`attachment-preview ${image ? 'attachment-image-preview' : 'attachment-file-preview'}`}
        key={`${attachment.name}-${index}`}
        title={attachment.name}
      >
        {image
          ? <img src={attachment.dataUrl} alt={attachment.name} />
          : <>
            <span className="attachment-file-icon" aria-hidden="true"><FileText size={18} /></span>
            <span className="attachment-file-copy"><strong>{attachment.name}</strong><small>{fileTypeLabel(attachment.name)}</small></span>
          </>}
        <button type="button" onClick={() => onRemove(index)} aria-label={`移除 ${attachment.name}`} title={`移除 ${attachment.name}`}><X size={12} /></button>
      </div>
    })}
  </div>
}

export function fileTypeLabel(name: string) {
  const extension = name.trim().match(/\.([^.\\/]+)$/)?.[1]
  return extension ? extension.toUpperCase() : 'FILE'
}
