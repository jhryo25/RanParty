// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { AttachmentStrip, fileTypeLabel } from './AttachmentStrip'

describe('AttachmentStrip', () => {
  it('renders image and file attachments together with distinct previews', () => {
    const onRemove = vi.fn()
    const { container } = render(<AttachmentStrip
      attachments={[
        { name: 'scan.png', mimeType: 'image/png', dataUrl: 'data:image/png;base64,eA==' },
        { name: '呼吸机监测数据.txt', mimeType: 'text/plain', dataUrl: 'data:text/plain;base64,eA==' },
      ]}
      onRemove={onRemove}
    />)

    expect(screen.getByRole('img', { name: 'scan.png' })).toBeInTheDocument()
    expect(screen.getByText('呼吸机监测数据.txt')).toBeInTheDocument()
    expect(screen.getByText('TXT')).toBeInTheDocument()
    expect(container.querySelectorAll('.attachment-image-preview')).toHaveLength(1)
    expect(container.querySelectorAll('.attachment-file-preview')).toHaveLength(1)

    fireEvent.click(screen.getByRole('button', { name: '移除 呼吸机监测数据.txt' }))
    expect(onRemove).toHaveBeenCalledWith(1)
  })

  it('uses a stable fallback label for extensionless files', () => {
    expect(fileTypeLabel('LICENSE')).toBe('FILE')
    expect(fileTypeLabel('report.final.pdf')).toBe('PDF')
  })
})
