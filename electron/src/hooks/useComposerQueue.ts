import { useCallback, useEffect, useState } from 'react'
import type { SendEnvelope, Session } from '../types'
import {
  endQueueSend,
  QueuedSend,
  readQueue,
  subscribeQueue,
  tryBeginQueueSend,
  updateQueue,
} from '../components/composer-store'

interface ComposerQueueOptions {
  sessions: Session[]
  onSend: (envelope: SendEnvelope) => Promise<void>
  onNotice: (notice: string) => void
}

export interface ComposerQueueState {
  queue: QueuedSend[]
  enqueue: (envelope: SendEnvelope) => void
  retry: (clientMessageId: string) => void
  remove: (clientMessageId: string) => void
}

export function useComposerQueue(options: ComposerQueueOptions): ComposerQueueState {
  const { sessions, onSend, onNotice } = options
  const [queue, setQueue] = useState<QueuedSend[]>(readQueue)

  useEffect(() => subscribeQueue(setQueue), [])

  const flushQueue = useCallback(async (next: QueuedSend) => {
    if (!tryBeginQueueSend()) return
    updateQueue((current) => current.map((item) => item.clientMessageId === next.clientMessageId
      ? { ...item, status: 'sending', error: undefined }
      : item))
    try {
      const { status: _status, error: _error, ...envelope } = next
      await onSend(envelope)
      updateQueue((current) => current.filter((item) => item.clientMessageId !== next.clientMessageId))
      onNotice('')
    } catch (error) {
      updateQueue((current) => current.map((item) => item.clientMessageId === next.clientMessageId
        ? { ...item, status: 'failed', error: messageOf(error) }
        : item))
      onNotice('队列消息发送失败，已保留以便重试。')
    } finally {
      endQueueSend()
    }
  }, [onNotice, onSend])

  useEffect(() => {
    const next = queue.find((item) => item.status === 'queued'
      && sessions.find((candidate) => candidate.id === item.sessionId)?.busy === false)
    if (!next) return () => {}
    const timer = window.setTimeout(() => void flushQueue(next), 300)
    return () => clearTimeout(timer)
  }, [flushQueue, queue, sessions])

  const enqueue = useCallback((envelope: SendEnvelope) => {
    updateQueue((current) => [...current, { ...envelope, status: 'queued' }])
  }, [])

  const retry = useCallback((clientMessageId: string) => {
    updateQueue((current) => current.map((item) => item.clientMessageId === clientMessageId
      ? { ...item, status: 'queued', error: undefined }
      : item))
  }, [])

  const remove = useCallback((clientMessageId: string) => {
    updateQueue((current) => current.filter((item) => item.clientMessageId !== clientMessageId))
  }, [])

  return { queue, enqueue, retry, remove }
}

function messageOf(reason: unknown) {
  return reason instanceof Error ? reason.message : String(reason)
}
