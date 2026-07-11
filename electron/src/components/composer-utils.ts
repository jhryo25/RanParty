import { Dispatch, SetStateAction } from 'react'
import type { Attachment, ConnectorConfig, Skill } from '../types'
import { MAX_IMAGE_BYTES, MAX_IMAGES } from './composer-store'

export async function filesToAttachments(files: File[]): Promise<Attachment[]> {
  const accepted = files.filter((file) => file.size <= MAX_IMAGE_BYTES).slice(0, MAX_IMAGES)
  return Promise.all(accepted.map((file) => new Promise<Attachment>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve({ name: file.name || `粘贴图片-${Date.now()}.png`, dataUrl: String(reader.result), size: file.size })
    reader.onerror = () => reject(reader.error ?? new Error('文件读取失败'))
    reader.readAsDataURL(file)
  })))
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
