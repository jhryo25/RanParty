import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ApprovalRequest, Bootstrap, Profile, Session, Settings } from '../types'
import { useBackendRuntime } from './use-backend-runtime'

let listener: ((event: string, data: unknown) => void) | undefined
let bootstrapRequests: number
let pendingApprovals: ApprovalRequest[]

describe('backend runtime coordination', () => {
  beforeEach(() => {
    listener = undefined
    bootstrapRequests = 0
    pendingApprovals = [{ approvalId: 'restored', sessionId: 's1', turnId: 't1', tool: 'shell_run', command: 'npm test', workdir: 'D:\\repo', reason: 'verify' }]
    window.ranparty = {
      isElectron: false,
      async request<T>(method: string) {
        if (method === 'app.bootstrap') {
          bootstrapRequests++
          return { sessions: [session, backgroundSession], settings, tools: [], eventCursor: bootstrapRequests === 1 ? 1 : 3, pendingApprovals, pendingClarifications: [] } as T
        }
        return { ok: true } as T
      },
      async chooseDirectory() { return null },
      async chooseImages() { return [] },
      async chooseFile() { return null },
      async clipboardWrite() { return { ok: true } },
      async pathAction() { return { ok: true } },
      onEvent(next) { listener = next; return () => { if (listener === next) listener = undefined } },
    }
  })

  it('restores pending state and resynchronizes after a sequence gap', async () => {
    const setRightOpen = vi.fn()
    const view = renderHook(() => useBackendRuntime({ setRightOpen }))
    await waitFor(() => expect(view.result.current.loading).toBe(false))
    expect(view.result.current.approvals.s1?.[0]).toMatchObject({ approvalId: 'restored', turnId: 't1' })
    expect(bootstrapRequests).toBe(1)

    act(() => listener?.('internal.notice', { sessionId: 's1', content: 'after gap', eventId: 'e3', sequence: 3 }))

    await waitFor(() => expect(bootstrapRequests).toBe(2))
    expect(view.result.current.items.s1).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'system_notice', content: 'after gap' })]))
    view.unmount()
    expect(listener).toBeUndefined()
  })

  it('keeps background failures and artifacts scoped to their session', async () => {
    const setRightOpen = vi.fn()
    const view = renderHook(() => useBackendRuntime({ setRightOpen }))
    await waitFor(() => expect(view.result.current.loading).toBe(false))

    act(() => listener?.('chat.error', { sessionId: 's2', turnId: 't2', message: 'background failed', eventId: 'bg-error', sequence: 2 }))
    act(() => listener?.('tool.completed', { sessionId: 's2', turnId: 't2', toolCallId: 'bg-tool', name: 'file_write', path: 'D:\\repo\\artifact.txt', content: 'ok', eventId: 'bg-tool-event', sequence: 3 }))

    expect(view.result.current.error).toBe('')
    expect(setRightOpen).not.toHaveBeenCalled()
    expect(view.result.current.items.s2).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'error', message: 'background failed' })]))
  })

  it('ignores a bootstrap snapshot older than an already applied live event', async () => {
    let resolveFirst!: (value: Bootstrap) => void
    let resolveSecond!: (value: Bootstrap) => void
    const first = new Promise<Bootstrap>((resolve) => { resolveFirst = resolve })
    const second = new Promise<Bootstrap>((resolve) => { resolveSecond = resolve })
    let requests = 0
    window.ranparty.request = async <T = unknown>(method: string) => {
      if (method !== 'app.bootstrap') return { ok: true } as T
      requests++
      return await (requests === 1 ? first : second) as T
    }

    const view = renderHook(() => useBackendRuntime({ setRightOpen: vi.fn() }))
    await waitFor(() => expect(listener).toBeTypeOf('function'))
    act(() => listener?.('session.created', { ...session, title: 'Live state', eventId: 'live-2', sequence: 2 }))
    expect(view.result.current.sessions[0]?.title).toBe('Live state')

    act(() => resolveFirst({ sessions: [{ ...session, title: 'Stale state', busy: true }], settings, tools: [], eventCursor: 1, pendingApprovals: [], pendingClarifications: [] }))
    await waitFor(() => expect(requests).toBe(2))
    expect(view.result.current.sessions[0]?.title).toBe('Live state')

    act(() => resolveSecond({ sessions: [{ ...session, title: 'Fresh state' }], settings, tools: [], eventCursor: 2, pendingApprovals: [], pendingClarifications: [] }))
    await waitFor(() => expect(view.result.current.sessions[0]?.title).toBe('Fresh state'))
  })
})

const session: Session = {
  id: 's1', title: 'Task', workspace: 'D:\\repo', profileName: 'test', model: 'test-model', displayName: 'AI',
  approvalMode: 'ask', permissionProfile: ':workspace', tokensIn: 0, tokensOut: 0, contextWindow: 128000,
  lastInputTokens: 0, contextTokens: 0, lastActive: new Date(0).toISOString(), busy: false, messages: [],
}

const backgroundSession: Session = { ...session, id: 's2', title: 'Background' }

const profile: Profile = {
  name: 'test', baseUrl: 'https://example.test', model: 'test-model', characterCard: '', characterDisplayName: 'AI', provider: 'openai',
  wireProtocol: 'chat_completions', supportsTools: true, supportsImages: true, supportsReasoning: true, contextWindow: 128000, maxOutputTokens: 8192, apiKeyConfigured: true,
}

const settings: Settings = {
  activeProfileName: 'test', profiles: [profile], ioRoots: 'D:\\repo', shellMode: 'ask', contextWindow: 128000, compactThreshold: 80, permissionProfile: ':workspace',
}
