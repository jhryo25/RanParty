import { describe, expect, it } from 'vitest'
import { attachmentMimeType, filesToAttachments, isImageAttachment, validateAttachments } from './composer-utils'

describe('composer attachment contract', () => {
  it('recognizes supported document and source formats when the browser omits MIME', () => {
    expect(attachmentMimeType('report.pdf')).toBe('application/pdf')
    expect(attachmentMimeType('component.tsx')).toBe('text/tsx')
    expect(attachmentMimeType('payload.bin')).toBe('')
  })

  it('turns dropped documents into typed data URLs', async () => {
    const [attachment] = await filesToAttachments([new File(['hello'], 'notes.md', { type: '' })])
    expect(attachment.mimeType).toBe('text/markdown')
    expect(attachment.dataUrl).toMatch(/^data:/)
    expect(isImageAttachment(attachment)).toBe(false)
  })

  it('rejects unsupported and oversized aggregate payloads', async () => {
    await expect(filesToAttachments([new File(['x'], 'payload.exe')])).rejects.toThrow('格式不受支持')
    expect(() => validateAttachments(Array.from({ length: 9 }, (_, index) => ({ name: `${index}.txt`, mimeType: 'text/plain', dataUrl: 'data:text/plain;base64,eA==', size: 1 })))).toThrow('最多添加 8 个附件')
  })
})
