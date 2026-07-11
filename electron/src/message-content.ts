import type { RawContent } from './types'

export function contentText(content: RawContent): string {
  if (content == null || typeof content === 'string') return content ?? ''
  return content.find((item) => item.type === 'text')?.text ?? ''
}

export function contentImages(content: RawContent): string[] {
  if (content == null || typeof content === 'string') return []
  return content.flatMap((item) => item.type === 'image_url' && item.image_url?.url ? [item.image_url.url] : [])
}

export function agentNameFromArguments(value = '') {
  try { return String(JSON.parse(value).profileName || '') } catch { return '' }
}
