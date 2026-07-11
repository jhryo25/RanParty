import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'
import App from './App'
import type { ApprovalRequest, ClarificationRequest, Profile, Session, Settings } from './types'

let backendListener: ((event: string, data: unknown) => void) | undefined
let bootstrapSessions: Session[]
let bootstrapCursor: number
let bootstrapApprovals: ApprovalRequest[]
let bootstrapClarifications: ClarificationRequest[]
let requests: Array<{ method: string; params?: Record<string, unknown> }>

describe('App session interaction contract', () => {
  beforeEach(() => {
    bootstrapSessions = [makeSession('s1', 'First task'), makeSession('s2', 'Second task')]
    bootstrapCursor = 0
    bootstrapApprovals = []
    bootstrapClarifications = []
    backendListener = undefined
    requests = []
    window.ranparty = {
      isElectron: false,
      async request<T>(method: string, params?: Record<string, unknown>) {
        requests.push({ method, params })
        if (method === 'app.bootstrap') return { sessions: bootstrapSessions, settings, tools: [], eventCursor: bootstrapCursor, pendingApprovals: bootstrapApprovals, pendingClarifications: bootstrapClarifications } as T
        if (method === 'skills.list') return { skills: [] } as T
        if (method === 'connectors.list') return { connectors: [] } as T
        return { ok: true } as T
      },
      async chooseDirectory() { return null },
      async chooseImages() { return [] },
      async chooseFile() { return null },
      async clipboardWrite() { return { ok: true } },
      async pathAction() { return { ok: true } },
      onEvent(listener) { backendListener = listener; return () => { if (backendListener === listener) backendListener = undefined } },
    }
  })

  it('keeps a background clarification attached to its own session', async () => {
    render(<App />)
    await screen.findByRole('heading', { name: 'First task' })

    act(() => backendListener?.('clarification.requested', {
      clarificationId: 'c2', sessionId: 's2', turnId: 't2', question: 'Second session question', options: [], multiSelect: false,
    }))

    expect(screen.queryByText('Second session question')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Second task/ })).toContainElement(screen.getByLabelText('等待你的确认'))
    act(() => screen.getByRole('button', { name: /Second task/ }).click())
    expect(await screen.findByText('Second session question')).toBeInTheDocument()
  })

  it('shows a usable first-level new-task page after deleting the final session', async () => {
    bootstrapSessions = [makeSession('only', 'Only task')]
    render(<App />)
    await screen.findByRole('heading', { name: 'Only task' })

    act(() => backendListener?.('session.deleted', { sessionId: 'only' }))

    await waitFor(() => expect(screen.getByRole('main', { name: '今天想让 AI 帮你做什么？' })).toBeInTheDocument())
    expect(screen.getByRole('button', { name: '创建并开始' })).toBeDisabled()
  })

  it('does not let an old turn clear a newer approval', async () => {
    bootstrapSessions = [{ ...makeSession('s1', 'First task'), busy: true, activeTurnId: 'turn-new', turnState: 'waiting_approval' }]
    render(<App />)
    await screen.findByRole('heading', { name: 'First task' })

    act(() => backendListener?.('approval.requested', {
      approvalId: 'approval-new', sessionId: 's1', turnId: 'turn-new', tool: 'shell_run', command: 'npm test', workdir: 'D:\\repo', reason: 'verify',
    }))
    expect(await screen.findByRole('alertdialog')).toBeInTheDocument()

    act(() => backendListener?.('turn.state', { sessionId: 's1', turnId: 'turn-old', state: 'completed' }))
    act(() => backendListener?.('chat.completed', { sessionId: 's1', turnId: 'turn-old' }))

    expect(screen.getByRole('alertdialog')).toBeInTheDocument()
    expect(screen.getByText('npm test')).toBeInTheDocument()
  })

  it('keeps the newest plan revision when a stale update arrives', async () => {
    bootstrapSessions = [{ ...makeSession('s1', 'Plan task'), mode: 'plan' }]
    render(<App />)
    await screen.findByRole('heading', { name: 'Plan task' })

    act(() => backendListener?.('plan.updated', { sessionId: 's1', planId: 'plan-1', revision: 2, plan: [{ step: 'new plan', status: 'pending' }] }))
    act(() => backendListener?.('plan.updated', { sessionId: 's1', planId: 'plan-1', revision: 1, plan: [{ step: 'stale plan', status: 'pending' }] }))

    expect(await screen.findByText('new plan')).toBeInTheDocument()
    expect(screen.queryByText('stale plan')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '同意执行' }))
    await waitFor(() => expect(requests.find((entry) => entry.method === 'plan.accept')?.params).toMatchObject({ planId: 'plan-1', revision: 2 }))
  })

  it('restores pending approvals from the bootstrap snapshot', async () => {
    bootstrapApprovals = [{ approvalId: 'restored', sessionId: 's2', turnId: 'turn-2', tool: 'shell_run', command: 'npm test', workdir: 'D:\\repo', reason: 'verify' }]
    render(<App />)
    await screen.findByRole('heading', { name: 'First task' })

    expect(screen.getByRole('button', { name: /Second task/ })).toContainElement(screen.getByLabelText('等待你的确认'))
    fireEvent.click(screen.getByRole('button', { name: /Second task/ }))
    expect(await screen.findByRole('alertdialog')).toHaveTextContent('npm test')
  })

  it('refreshes bootstrap when the backend event sequence has a gap', async () => {
    bootstrapCursor = 1
    render(<App />)
    await screen.findByRole('heading', { name: 'First task' })
    expect(requests.filter((entry) => entry.method === 'app.bootstrap')).toHaveLength(1)

    act(() => backendListener?.('internal.notice', { sessionId: 's1', content: 'after gap', eventId: 'event-3', sequence: 3 }))

    await waitFor(() => expect(requests.filter((entry) => entry.method === 'app.bootstrap')).toHaveLength(2))
    expect(screen.getByText('after gap')).toBeInTheDocument()
  })
})

function makeSession(id: string, title: string): Session {
  return {
    id, title, workspace: 'D:\\repo', profileName: 'test', model: 'test-model', displayName: 'AI', approvalMode: 'ask', permissionProfile: ':workspace',
    tokensIn: 0, tokensOut: 0, contextWindow: 128000, lastInputTokens: 0, contextTokens: 0, lastActive: new Date(0).toISOString(), busy: false, messages: [],
  }
}

const profile: Profile = {
  name: 'test', baseUrl: 'https://example.test', model: 'test-model', characterCard: '', characterDisplayName: 'AI', provider: 'openai',
  wireProtocol: 'chat_completions', supportsTools: true, supportsImages: true, supportsReasoning: true, contextWindow: 128000, maxOutputTokens: 8192, apiKeyConfigured: true,
}

const settings: Settings = {
  activeProfileName: 'test', profiles: [profile], ioRoots: 'D:\\repo', shellMode: 'ask', contextWindow: 128000, compactThreshold: 80, permissionProfile: ':workspace',
}
