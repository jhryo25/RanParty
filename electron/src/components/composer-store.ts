import type { Attachment, SendEnvelope } from '../types'

export const MAX_ATTACHMENTS = 8
export const MAX_IMAGES = MAX_ATTACHMENTS
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024
export const MAX_DOCUMENT_BYTES = 10 * 1024 * 1024
export const MAX_ATTACHMENT_BYTES_PER_TURN = 25 * 1024 * 1024

export interface StoredDraft {
  text: string
  attachments: Attachment[]
  skillIds: string[]
  expertIds: string[]
  expertTeamId: string
  updatedAt: number
}

export type QueuedSend = SendEnvelope & {
  status: 'queued' | 'sending' | 'failed'
  error?: string
}

const DRAFT_STORAGE_KEY = 'ranparty.composer-drafts.v1'
const QUEUE_STORAGE_KEY = 'ranparty.composer-queue.v1'
const MAX_STORED_DRAFTS = 20
const MAX_PERSISTED_TEXT_LENGTH = 100_000
const volatileDrafts = new Map<string, StoredDraft>()
const queueListeners = new Set<(queue: QueuedSend[]) => void>()
let draftsLoaded = false
let queueStore: QueuedSend[] | null = null
let queueSending = false

export function emptyDraft(): StoredDraft {
  return { text: '', attachments: [], skillIds: [], expertIds: [], expertTeamId: '', updatedAt: Date.now() }
}

export function readDraft(sessionId: string): StoredDraft {
  ensureDraftsLoaded()
  const stored = volatileDrafts.get(sessionId)
  return stored
    ? { ...stored, expertTeamId: stored.expertTeamId ?? '', attachments: [...stored.attachments], skillIds: [...stored.skillIds], expertIds: [...stored.expertIds] }
    : emptyDraft()
}

export function writeDraft(sessionId: string, draft: StoredDraft) {
  ensureDraftsLoaded()
  volatileDrafts.set(sessionId, {
    text: draft.text,
    // Attachment payloads remain process-local. Persisting them in localStorage
    // would make draft recovery dependent on a small, browser-managed quota.
    attachments: draft.attachments
      .filter((item) => attachmentWithinLimits(item))
      .slice(0, MAX_ATTACHMENTS),
    skillIds: [...new Set(draft.skillIds)],
    expertIds: [...new Set(draft.expertIds)],
    expertTeamId: draft.expertTeamId ?? '',
    updatedAt: Date.now(),
  })
  const ordered = [...volatileDrafts.entries()].sort((left, right) => right[1].updatedAt - left[1].updatedAt)
  for (const [id] of ordered.slice(MAX_STORED_DRAFTS)) volatileDrafts.delete(id)
  let attachmentBytes = ordered.slice(0, MAX_STORED_DRAFTS)
    .reduce((total, [, value]) => total + value.attachments.reduce((sum, item) => sum + (item.size ?? dataUrlBytes(item.dataUrl)), 0), 0)
  for (const [id, value] of [...ordered].reverse()) {
    if (attachmentBytes <= 96 * 1024 * 1024) break
    attachmentBytes -= value.attachments.reduce((sum, item) => sum + (item.size ?? dataUrlBytes(item.dataUrl)), 0)
    volatileDrafts.set(id, { ...value, attachments: [] })
  }
  persistDrafts()
}

export function readQueue(): QueuedSend[] {
  if (queueStore) return [...queueStore]
  queueStore = []
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(QUEUE_STORAGE_KEY) || '[]')
    if (Array.isArray(parsed)) {
      queueStore = parsed.flatMap((value) => {
        const item = queuedSend(value)
        return item ? [item] : []
      })
    }
  } catch { /* Corrupt or unavailable storage starts empty. */ }
  return [...queueStore]
}

export function updateQueue(updater: (current: QueuedSend[]) => QueuedSend[]) {
  const next = updater(readQueue())
  queueStore = next
  persistQueue(next)
  for (const listener of queueListeners) listener([...next])
}

export function subscribeQueue(listener: (queue: QueuedSend[]) => void) {
  queueListeners.add(listener)
  listener(readQueue())
  return () => { queueListeners.delete(listener) }
}

export function tryBeginQueueSend() {
  if (queueSending) return false
  queueSending = true
  return true
}

export function endQueueSend() {
  queueSending = false
}

export function dataUrlBytes(value: string) {
  return Math.ceil((value.split(',')[1]?.length ?? 0) * 3 / 4)
}

function ensureDraftsLoaded() {
  if (draftsLoaded) return
  draftsLoaded = true
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(DRAFT_STORAGE_KEY) || '{}')
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return
    for (const [sessionId, value] of Object.entries(parsed)) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) continue
      const text = Reflect.get(value, 'text')
      const skillIds = Reflect.get(value, 'skillIds')
      const expertIds = Reflect.get(value, 'expertIds')
      const expertTeamId = Reflect.get(value, 'expertTeamId')
      const updatedAt = Reflect.get(value, 'updatedAt')
      volatileDrafts.set(sessionId, {
        text: typeof text === 'string' ? text : '',
        attachments: [],
        skillIds: stringArray(skillIds),
        expertIds: stringArray(expertIds),
        expertTeamId: typeof expertTeamId === 'string' ? expertTeamId : '',
        updatedAt: typeof updatedAt === 'number' ? updatedAt : 0,
      })
    }
  } catch { /* Corrupt or unavailable storage starts empty. */ }
}

function persistDrafts() {
  try {
    const serializable = Object.fromEntries([...volatileDrafts.entries()]
      .sort((left, right) => right[1].updatedAt - left[1].updatedAt)
      .slice(0, MAX_STORED_DRAFTS)
      .map(([sessionId, value]) => [sessionId, {
        text: value.text.slice(0, MAX_PERSISTED_TEXT_LENGTH),
        skillIds: value.skillIds,
        expertIds: value.expertIds,
        updatedAt: value.updatedAt,
      }]))
    localStorage.setItem(DRAFT_STORAGE_KEY, JSON.stringify(serializable))
  } catch { /* In-memory drafts remain available when storage quota is unavailable. */ }
}

function persistQueue(queue: QueuedSend[]) {
  try {
    const serializable = queue
      .filter((item) => item.imageDataUrls.length === 0)
      .slice(-50)
      .map((item) => ({ ...item, status: item.status === 'sending' ? 'queued' : item.status }))
    localStorage.setItem(QUEUE_STORAGE_KEY, JSON.stringify(serializable))
  } catch { /* In-memory queue remains available when storage quota is unavailable. */ }
}

function queuedSend(value: unknown): QueuedSend | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const clientMessageId = Reflect.get(value, 'clientMessageId')
  const sessionId = Reflect.get(value, 'sessionId')
  const text = Reflect.get(value, 'text')
  const status = Reflect.get(value, 'status')
  if (typeof clientMessageId !== 'string' || typeof sessionId !== 'string' || typeof text !== 'string') return null
  if (status !== 'queued' && status !== 'sending' && status !== 'failed') return null
  const error = Reflect.get(value, 'error')
  return {
    clientMessageId,
    sessionId,
    text,
    imageDataUrls: stringArray(Reflect.get(value, 'imageDataUrls')).filter((item) => item.startsWith('data:image/')).slice(0, MAX_IMAGES),
    fileDataUrls: [],
    skillIds: stringArray(Reflect.get(value, 'skillIds')),
    expertIds: stringArray(Reflect.get(value, 'expertIds')),
    referencedSessionIds: stringArray(Reflect.get(value, 'referencedSessionIds')),
    status: status === 'sending' ? 'queued' : status,
    error: typeof error === 'string' ? error : undefined,
  }
}

function stringArray(value: unknown) {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}

function attachmentWithinLimits(item: Attachment) {
  const bytes = item.size ?? dataUrlBytes(item.dataUrl)
  return item.dataUrl.startsWith('data:image/') ? bytes <= MAX_IMAGE_BYTES : bytes <= MAX_DOCUMENT_BYTES
}
