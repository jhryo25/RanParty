import { describe, expect, it } from 'vitest'
import { normalizeBackendEvent } from './backend-events'

describe('backend event adapter', () => {
  it('requires turn identity for blocking requests', () => {
    expect(normalizeBackendEvent('approval.requested', { approvalId: 'a1', sessionId: 's1' })).toBeNull()
    expect(normalizeBackendEvent('clarification.requested', { clarificationId: 'c1', sessionId: 's1' })).toBeNull()
    expect(normalizeBackendEvent('approval.requested', {
      approvalId: 'a1', sessionId: 's1', turnId: 't1', tool: 'shell_run', command: 'npm test', workdir: 'D:\\repo', reason: 'verify',
    })).toMatchObject({ type: 'approval.requested', approval: { approvalId: 'a1', sessionId: 's1', turnId: 't1' } })
  })

  it('normalizes tool aliases and filters malformed plan steps', () => {
    expect(normalizeBackendEvent('tool.started', { sessionId: 's1', turnId: 't1', callId: 'call-1', name: 'file_read' }))
      .toMatchObject({ type: 'tool.started', toolCallId: 'call-1', turnId: 't1' })
    expect(normalizeBackendEvent('plan.updated', {
      sessionId: 's1', planId: 'p1', revision: 2,
      plan: [{ step: 'valid', status: 'pending' }, { step: 42, status: 'completed' }, { step: 'invalid', status: 'unknown' }],
    })).toMatchObject({ type: 'plan.updated', plan: [{ step: 'valid', status: 'pending' }] })
  })
})
