import type { Session, ThreadItem } from '../types'
import { enqueuePending, type PendingBySession } from './thread-state'

export type ItemMap = Record<string, ThreadItem[]>
export type PlanVersion = { planId: string; revision: number }

export function genId(prefix: string) {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`
}

export function removeTurnPending<T extends { turnId: string }>(current: PendingBySession<T>, sessionId: string, turnId: string): PendingBySession<T> {
  const existing = current[sessionId]
  if (!existing?.some((request) => request.turnId === turnId)) return current
  const remaining = existing.filter((request) => request.turnId !== turnId)
  if (remaining.length > 0) return { ...current, [sessionId]: remaining }
  const next = { ...current }
  delete next[sessionId]
  return next
}

export function mergePendingQueues<T extends { sessionId: string }>(current: PendingBySession<T>, incoming: T[], idOf: (request: T) => string): PendingBySession<T> {
  return incoming.reduce((next, request) => enqueuePending(next, request, idOf), current)
}

export function planVersionOf(session: Session): [string, PlanVersion] | null {
  const planId = session.planId?.trim() ?? ''
  const revision = session.planRevision ?? 0
  return planId && revision > 0 ? [session.id, { planId, revision }] : null
}

export function preserveKnownPlan(session: Session, known?: PlanVersion): Session {
  if (!known) return session
  const incomingId = session.planId?.trim() ?? ''
  const incomingRevision = session.planRevision ?? 0
  if (incomingId === known.planId && incomingRevision >= known.revision) return session
  return { ...session, planId: known.planId, planRevision: known.revision }
}
