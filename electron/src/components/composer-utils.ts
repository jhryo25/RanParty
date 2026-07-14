import { Dispatch, SetStateAction } from 'react'
import type { Attachment, ConnectorConfig, Skill } from '../types'
import { MAX_ATTACHMENTS, MAX_ATTACHMENT_BYTES_PER_TURN, MAX_DOCUMENT_BYTES, MAX_IMAGE_BYTES } from './composer-store'

const MIME_BY_EXTENSION: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp',
  pdf: 'application/pdf', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  txt: 'text/plain', md: 'text/markdown', markdown: 'text/markdown', csv: 'text/csv', tsv: 'text/tab-separated-values',
  json: 'application/json', jsonl: 'application/x-ndjson', xml: 'application/xml', html: 'text/html', htm: 'text/html', css: 'text/css',
  log: 'text/plain', yaml: 'text/yaml', yml: 'text/yaml', toml: 'text/toml', ini: 'text/plain', cfg: 'text/plain',
  js: 'text/javascript', jsx: 'text/jsx', ts: 'text/typescript', tsx: 'text/tsx', py: 'text/x-python', java: 'text/x-java',
  cs: 'text/x-csharp', go: 'text/x-go', rs: 'text/x-rust', c: 'text/x-c', cpp: 'text/x-c++', cc: 'text/x-c++',
  h: 'text/x-c', hpp: 'text/x-c++', sh: 'text/x-shellscript', ps1: 'text/x-powershell', sql: 'text/x-sql',
  rb: 'text/x-ruby', php: 'text/x-php', swift: 'text/x-swift', kt: 'text/x-kotlin', scala: 'text/x-scala',
  r: 'text/x-r', lua: 'text/x-lua', vue: 'text/x-vue', svelte: 'text/x-svelte', env: 'text/plain',
}

export const SUPPORTED_ATTACHMENT_EXTENSIONS = Object.freeze(Object.keys(MIME_BY_EXTENSION))

export async function filesToAttachments(files: File[]): Promise<Attachment[]> {
  if (files.length > MAX_ATTACHMENTS) throw new Error(`一次最多添加 ${MAX_ATTACHMENTS} 个附件。`)
  let totalBytes = 0
  const accepted = files.map((file) => {
    const mimeType = attachmentMimeType(file.name, file.type)
    if (!mimeType) throw new Error(`${file.name || '未命名文件'} 的格式不受支持。`)
    const limit = mimeType.startsWith('image/') ? MAX_IMAGE_BYTES : MAX_DOCUMENT_BYTES
    if (file.size <= 0 || file.size > limit) throw new Error(`${file.name} 超过 ${formatBytes(limit)} 上限或内容为空。`)
    totalBytes += file.size
    return { file, mimeType }
  })
  if (totalBytes > MAX_ATTACHMENT_BYTES_PER_TURN) throw new Error(`附件总大小不能超过 ${formatBytes(MAX_ATTACHMENT_BYTES_PER_TURN)}。`)
  return Promise.all(accepted.map(({ file, mimeType }) => new Promise<Attachment>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve({ name: file.name || `attachment-${Date.now()}`, dataUrl: String(reader.result), size: file.size, mimeType })
    reader.onerror = () => reject(reader.error ?? new Error('文件读取失败'))
    reader.readAsDataURL(file)
  })))
}

export function attachmentMimeType(name: string, browserMimeType = '') {
  const extension = name.split('.').at(-1)?.toLocaleLowerCase() ?? ''
  const expected = MIME_BY_EXTENSION[extension]
  if (!expected) return ''
  if (expected.startsWith('image/') && browserMimeType && !browserMimeType.startsWith('image/')) return ''
  return expected
}

export function isImageAttachment(attachment: Attachment) {
  return Boolean(attachment.mimeType?.startsWith('image/') || attachment.dataUrl.startsWith('data:image/'))
}

export function validateAttachments(items: Attachment[], existing: Attachment[] = []) {
  if (existing.length + items.length > MAX_ATTACHMENTS) throw new Error(`一次最多添加 ${MAX_ATTACHMENTS} 个附件。`)
  let total = existing.reduce((sum, item) => sum + attachmentBytes(item), 0)
  for (const item of items) {
    const mimeType = item.mimeType || attachmentMimeType(item.name, dataUrlMime(item.dataUrl))
    if (!mimeType) throw new Error(`${item.name} 的格式不受支持。`)
    const bytes = attachmentBytes(item)
    const limit = mimeType.startsWith('image/') ? MAX_IMAGE_BYTES : MAX_DOCUMENT_BYTES
    if (bytes <= 0 || bytes > limit) throw new Error(`${item.name} 超过 ${formatBytes(limit)} 上限或内容为空。`)
    total += bytes
  }
  if (total > MAX_ATTACHMENT_BYTES_PER_TURN) throw new Error(`附件总大小不能超过 ${formatBytes(MAX_ATTACHMENT_BYTES_PER_TURN)}。`)
}

function attachmentBytes(item: Attachment) {
  return item.size ?? Math.ceil((item.dataUrl.split(',')[1]?.length ?? 0) * 3 / 4)
}

function dataUrlMime(value: string) {
  return /^data:([^;,]+)[;,]/i.exec(value)?.[1] ?? ''
}

function formatBytes(value: number) {
  return `${Math.round(value / 1024 / 1024)}MB`
}

export function toggleId(setter: Dispatch<SetStateAction<string[]>>, id: string) {
  setter((current) => current.includes(id) ? current.filter((item) => item !== id) : [...current, id])
}

export function filterSkills(items: Skill[], query: string) {
  const normalized = query.trim().toLocaleLowerCase()
  if (!normalized) return items
  return items.filter((skill) => `${skill.name} ${skill.description} ${skill.source} ${skill.pathLabel}`.toLocaleLowerCase().includes(normalized))
}

export function isExpertSkill(skill: Skill) {
  const value = `${skill.source} ${skill.pathLabel} ${skill.name}`.toLocaleLowerCase()
  return value.includes('soul') || value.includes('pack') || value.includes('expert') || value.includes('专家')
}

export function connectorStatus(connector: ConnectorConfig) {
  if (!connector.enabled) return '未启用'
  if (connector.status === 'connected') return '已连接'
  if (connector.status === 'failed') return `启动失败：${connector.lastError || '未知错误'}`
  if (connector.status === 'not_configured') return '需要配置'
  return '未连接'
}

export function extractSessionReferenceIds(value: string) {
  const ids = new Set<string>()
  const matcher = /(?:@session:|ranparty:\/\/session\/)([A-Za-z0-9_\-]+)/gi
  for (let match = matcher.exec(value); match; match = matcher.exec(value)) ids.add(match[1])
  return [...ids]
}

export function stripSessionReferences(value: string, referenceIds: string[]) {
  let cleaned = value
  for (const id of referenceIds) {
    const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const boundary = '(?![A-Za-z0-9_-])'
    cleaned = cleaned.replace(new RegExp(`@session:${escaped}${boundary}`, 'gi'), '')
    cleaned = cleaned.replace(new RegExp(`ranparty://session/${escaped}${boundary}`, 'gi'), '')
  }
  return cleaned.trim()
}

export function workspaceName(value: string) {
  const parts = value.split(/[\\/]/).filter(Boolean)
  return parts.length > 1 ? `${parts[0]}\\...\\${parts[parts.length - 1]}` : value
}

export function formatTokens(value: number) {
  return value >= 1000 ? `${(value / 1000).toFixed(value >= 10000 ? 0 : 1)}K` : `${value}`
}

export function formatLastActive(value: string) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  const now = new Date()
  if (date.toDateString() === now.toDateString()) return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  const yesterday = new Date(now)
  yesterday.setDate(now.getDate() - 1)
  if (date.toDateString() === yesterday.toDateString()) return '昨天'
  return date.toLocaleDateString([], { month: '2-digit', day: '2-digit' })
}

export function messageOf(reason: unknown) {
  return reason instanceof Error ? reason.message : String(reason)
}
