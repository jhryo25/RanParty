import { describe, expect, it } from 'vitest'
import type { ApprovalRequest, ClarificationRequest, ThreadEvent, ThreadItem } from '../types'
import {
  applyThreadEvent,
  approvalId,
  clarificationId,
  dequeuePending,
  enqueuePending,
  reconcileSessionSnapshot,
} from './thread-state'

const id = (prefix: string) => `${prefix}_test`

describe('thread event contract', () => {
  it('upserts a missing streaming message and reaches a terminal state', () => {
    let items: ThreadItem[] = []
    items = applyThreadEvent(items, { type: 'assistant.delta', sessionId: 's1', messageId: 'm1', delta: 'hello' }, id)
    items = applyThreadEvent(items, { type: 'assistant.completed', sessionId: 's1', messageId: 'm1', content: 'hello world', usageIn: 10, usageOut: 2, model: 'test' }, id)

    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ id: 'm1', type: 'assistant_message', content: 'hello world', streaming: false, status: 'completed' })
  })

  it('binds parallel same-name tool results by toolCallId', () => {
    let items: ThreadItem[] = []
    items = applyThreadEvent(items, tool('tool.started', 'call-1', '{"path":"one"}'), id)
    items = applyThreadEvent(items, tool('tool.started', 'call-2', '{"path":"two"}'), id)
    items = applyThreadEvent(items, { type: 'tool.completed', sessionId: 's1', toolCallId: 'call-1', name: 'file_read', arguments: '{"path":"one"}', content: 'first', path: 'one', isError: false }, id)
    items = applyThreadEvent(items, { type: 'tool.completed', sessionId: 's1', toolCallId: 'call-2', name: 'file_read', arguments: '{"path":"two"}', content: 'second', path: 'two', isError: false }, id)

    expect(items.find((item) => item.type === 'tool_result' && item.toolCallId === 'call-1')).toMatchObject({ content: 'first', toolPath: 'one' })
    expect(items.find((item) => item.type === 'tool_result' && item.toolCallId === 'call-2')).toMatchObject({ content: 'second', toolPath: 'two' })
  })

  it('upserts live plan revisions instead of duplicating cards', () => {
    let items: ThreadItem[] = []
    items = applyThreadEvent(items, { type: 'plan.updated', sessionId: 's1', planId: 'p1', revision: 1, plan: [{ step: 'A', status: 'in_progress' }] }, id)
    items = applyThreadEvent(items, { type: 'plan.updated', sessionId: 's1', planId: 'p1', revision: 2, plan: [{ step: 'A', status: 'completed' }] }, id)

    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ id: 'plan_p1', type: 'plan_step', steps: [{ step: 'A', status: 'completed' }] })
    items = applyThreadEvent(items, { type: 'plan.updated', sessionId: 's1', planId: 'p1', revision: 1, plan: [{ step: 'stale', status: 'pending' }] }, id)
    expect(items[0]).toMatchObject({ revision: 2, steps: [{ step: 'A', status: 'completed' }] })
  })

  it('ends streaming and running tools on chat.error', () => {
    const running: ThreadItem[] = [
      { type: 'assistant_message', id: 'm1', status: 'in_progress', content: 'partial', streaming: true },
      { type: 'tool_result', id: 't1', status: 'in_progress', toolName: 'file_read', content: '', toolError: false },
    ]
    const items = applyThreadEvent(running, { type: 'chat.error', sessionId: 's1', message: 'offline' }, id)

    expect(items[0]).toMatchObject({ status: 'failed', streaming: false, error: true })
    expect(items[1]).toMatchObject({ status: 'failed', toolError: true })
    expect(items.at(-1)).toMatchObject({ type: 'error', message: 'offline' })
  })

  it('marks active work as cancelled instead of completed', () => {
    const running: ThreadItem[] = [
      { type: 'assistant_message', id: 'm1', status: 'in_progress', content: '', streaming: true },
      { type: 'tool_result', id: 't1', status: 'in_progress', toolName: 'shell_run', content: '', toolError: false },
    ]
    const items = applyThreadEvent(running, { type: 'chat.cancelled', sessionId: 's1' }, id)
    expect(items[0]).toMatchObject({ status: 'cancelled', streaming: false })
    expect(items[1]).toMatchObject({ status: 'cancelled', toolError: false })
  })

  it('upserts retry progress and closes it when the turn completes', () => {
    let items: ThreadItem[] = []
    items = applyThreadEvent(items, { type: 'turn.retrying', sessionId: 's1', turnId: 'turn-1', attempt: 1, maxAttempts: 3, delayMs: 2000 }, id)
    items = applyThreadEvent(items, { type: 'turn.retrying', sessionId: 's1', turnId: 'turn-1', attempt: 2, maxAttempts: 3, delayMs: 4000 }, id)
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ id: 'retry_turn-1', status: 'in_progress' })
    items = applyThreadEvent(items, { type: 'turn.state', sessionId: 's1', turnId: 'turn-1', state: 'completed' }, id)
    expect(items[0]).toMatchObject({ status: 'completed' })
  })

  it('preserves a terminal live item while reconciling a restored snapshot', () => {
    const live: ThreadItem[] = [{ type: 'assistant_message', id: 'm1', status: 'completed', content: 'partial before cancel', streaming: false }]
    const snapshot: ThreadItem[] = [{ type: 'user_message', id: 'history_0', status: 'completed', content: 'request' }]
    expect(reconcileSessionSnapshot(live, snapshot, false)).toHaveLength(2)
  })

  it('does not let a late terminal event finish a newer turn', () => {
    const running: ThreadItem[] = [
      { type: 'assistant_message', id: 'old', turnId: 'turn-old', status: 'in_progress', content: 'old', streaming: true },
      { type: 'assistant_message', id: 'new', turnId: 'turn-new', status: 'in_progress', content: 'new', streaming: true },
    ]
    const items = applyThreadEvent(running, { type: 'chat.cancelled', sessionId: 's1', turnId: 'turn-old' }, id)
    expect(items[0]).toMatchObject({ status: 'cancelled' })
    expect(items[1]).toMatchObject({ status: 'in_progress', streaming: true })
  })

  it('merges a busy bootstrap snapshot without dropping live stream state', () => {
    const live: ThreadItem[] = [{ type: 'assistant_message', id: 'm1', turnId: 't1', status: 'in_progress', content: 'delta', streaming: true }]
    const snapshot: ThreadItem[] = [{ type: 'user_message', id: 'history_0', turnId: 't1', status: 'completed', content: 'request' }]
    expect(reconcileSessionSnapshot(live, snapshot, true)).toEqual([snapshot[0], live[0]])
  })
})

describe('session-scoped pending queues', () => {
  it('keeps approvals and clarifications isolated by session', () => {
    const a1: ApprovalRequest = { approvalId: 'a1', sessionId: 's1', turnId: 't1', tool: 'shell_run', command: 'one', workdir: 'w', reason: '' }
    const a2: ApprovalRequest = { approvalId: 'a2', sessionId: 's2', turnId: 't2', tool: 'shell_run', command: 'two', workdir: 'w', reason: '' }
    const c1: ClarificationRequest = { clarificationId: 'c1', sessionId: 's1', turnId: 't1', question: '?', options: [], multiSelect: false }

    let approvals = enqueuePending({}, a1, approvalId)
    approvals = enqueuePending(approvals, a2, approvalId)
    const clarifications = enqueuePending({}, c1, clarificationId)

    expect(approvals.s1[0]).toBe(a1)
    expect(approvals.s2[0]).toBe(a2)
    expect(clarifications.s1[0]).toBe(c1)
    approvals = dequeuePending(approvals, 's1', 'a1', approvalId)
    expect(approvals.s1).toBeUndefined()
    expect(approvals.s2[0]).toBe(a2)
  })
})

function tool(type: 'tool.started' | 'tool.completed', toolCallId: string, args: string): Extract<ThreadEvent, { type: 'tool.started' | 'tool.completed' }> {
  return type === 'tool.started'
    ? { type, sessionId: 's1', toolCallId, name: 'file_read', arguments: args }
    : { type, sessionId: 's1', toolCallId, name: 'file_read', arguments: args, content: '', isError: false }
}
