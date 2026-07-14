import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ApprovalRequest, ClarificationRequest, Profile, SendEnvelope, Session, Settings } from '../types'
import { ApprovalModal } from './ApprovalModal'
import { ClarificationCard } from './ClarificationCard'
import { Composer } from './Composer'
import { NewTaskModal } from './NewTaskModal'
import { PlanCard } from './PlanCard'
import { RightPanel } from './RightPanel'
import { SettingsDrawer } from './SettingsDrawer'
import { Transcript } from './Transcript'

describe('blocking interaction contracts', () => {
  beforeEach(() => {
    localStorage.clear()
    window.ranparty = {
      isElectron: false,
      async request<T>(method: string) {
        if (method === 'connectors.list') return { connectors: [] } as T
        if (method === 'workspace.files') return { files: [] } as T
        return { skills: [] } as T
      },
      async chooseDirectory() { return null },
      async chooseImages() { return [] },
      async chooseFile() { return null },
      async clipboardWrite() { return { ok: true } },
      async pathAction() { return { ok: true } },
      onEvent() { return () => {} },
    }
  })

  it('keeps a clarification answer after a failed response', async () => {
    const clarification: ClarificationRequest = { clarificationId: 'c1', sessionId: 's1', turnId: 't1', question: 'Which?', options: [], multiSelect: false }
    const onRespond = vi.fn().mockRejectedValue(new Error('backend unavailable'))
    render(<ClarificationCard clarification={clarification} onRespond={onRespond} onCancel={vi.fn()} />)

    const input = screen.getByRole('textbox', { name: '澄清回复' })
    expect(input).toHaveFocus()
    fireEvent.change(input, { target: { value: 'keep this answer' } })
    fireEvent.click(screen.getByRole('button', { name: '回复' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('backend unavailable')
    expect(input).toHaveValue('keep this answer')
  })

  it('focuses the safe approval action and keeps the dialog on failure', async () => {
    const approval: ApprovalRequest = { approvalId: 'a1', sessionId: 's1', turnId: 't1', tool: 'shell_run', command: 'git push', workdir: 'D:\\repo', reason: 'publish' }
    const onRespond = vi.fn().mockRejectedValue(new Error('request expired'))
    render(<ApprovalModal approval={approval} sessionTitle="Release" onRespond={onRespond} />)

    expect(screen.getByRole('button', { name: '拒绝' })).toHaveFocus()
    fireEvent.click(screen.getByRole('button', { name: '仅本次允许' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('request expired')
    expect(screen.getByRole('alertdialog')).toBeInTheDocument()
  })

  it('does not close or erase a new task when creation fails', async () => {
    const onClose = vi.fn()
    const onCreate = vi.fn().mockRejectedValue(new Error('send failed'))
    render(<NewTaskModal initialWorkspace="D:\\repo" workspaces={['D:\\repo']} profiles={[profile]} onClose={onClose} onBrowse={vi.fn()} onCreate={onCreate} />)

    const prompt = screen.getByPlaceholderText(/例如：/)
    fireEvent.change(prompt, { target: { value: 'review the project' } })
    fireEvent.click(screen.getByRole('button', { name: '开始任务' }))

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('send failed'))
    expect(onClose).not.toHaveBeenCalled()
    expect(prompt).toHaveValue('review the project')
  })

  it('manages task-picker focus without leaking into adjacent menus', async () => {
    render(<NewTaskModal initialWorkspace={'D:\\repo'} workspaces={['D:\\repo']} profiles={[profile]} onClose={vi.fn()} onBrowse={vi.fn().mockResolvedValue('')} onCreate={vi.fn()} />)

    const workspacePicker = screen.getByRole('button', { name: /D:\\.*repo/ })
    fireEvent.click(workspacePicker)
    const workspaceItem = screen.getByRole('menuitemradio', { name: /repo/ })
    await waitFor(() => expect(workspaceItem).toHaveFocus())
    fireEvent.keyDown(workspaceItem, { key: 'ArrowDown' })
    expect(screen.getByRole('menuitem', { name: /浏览文件夹/ })).toHaveFocus()
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'Escape' })

    await waitFor(() => expect(workspacePicker).toHaveFocus())
    expect(screen.queryByRole('menuitemradio', { name: /repo/ })).not.toBeInTheDocument()
  })

  it('persists an explicit Anthropic-compatible profile selection', async () => {
    const settings: Settings = { activeProfileName: profile.name, profiles: [profile], ioRoots: '', shellMode: 'ask', contextWindow: 128000, compactThreshold: 80, permissionProfile: ':workspace' }
    const request = vi.fn(async <T,>(method: string, params?: Record<string, unknown>) => {
      if (method === 'characters.list') return { characters: [] } as T
      if (method === 'profiles.save') {
        const savedProfile = (params?.profile ?? {}) as Profile
        return { ...settings, profiles: [{ ...savedProfile, apiKeyConfigured: true }] } as T
      }
      return {} as T
    })
    window.ranparty.request = request as typeof window.ranparty.request
    render(<SettingsDrawer settings={settings} onClose={vi.fn()} onSave={vi.fn().mockResolvedValue(undefined)} />)

    fireEvent.click(screen.getByRole('button', { name: 'Anthropic 兼容' }))
    expect(screen.getByText(/实际请求：https:\/\/example\.test\/messages/)).toBeInTheDocument()
    fireEvent.keyDown(screen.getByDisplayValue('test'), { key: 's', ctrlKey: true })

    await waitFor(() => expect(screen.getByRole('button', { name: '已保存' })).toBeDisabled())
    const saveCall = request.mock.calls.find(([method]) => method === 'profiles.save')
    expect(saveCall?.[1]).toMatchObject({ profile: { provider: 'anthropic', wireProtocol: 'anthropic_messages' } })
    expect(screen.getByRole('button', { name: 'Anthropic 兼容' })).toHaveClass('selected')
  })

  it('keeps keyboard focus inside the settings dialog', () => {
    const settings: Settings = { activeProfileName: profile.name, profiles: [profile], ioRoots: '', shellMode: 'ask', contextWindow: 128000, compactThreshold: 80, permissionProfile: ':workspace' }
    render(<SettingsDrawer settings={settings} onClose={vi.fn()} onSave={vi.fn().mockResolvedValue(undefined)} />)

    const close = screen.getByRole('button', { name: '关闭设置' })
    expect(close).toHaveFocus()
    fireEvent.keyDown(close, { key: 'Tab', shiftKey: true })

    expect(screen.getByRole('dialog', { name: '设置' })).toContainElement(document.activeElement as HTMLElement)
    expect(close).not.toHaveFocus()
  })

  it('sends a session-bound envelope and preserves the draft after failure', async () => {
    const onSend = vi.fn().mockRejectedValue(new Error('offline'))
    render(<Composer
      busy={false}
      session={session}
      sessions={[session]}
      profiles={[profile]}
      workspaces={[session.workspace]}
      contextUsed={0}
      contextWindow={128000}
      onSend={onSend}
      onStop={vi.fn()}
      onUpdate={vi.fn().mockResolvedValue(undefined)}
      onPickWorkspace={vi.fn().mockResolvedValue(undefined)}
      onChooseImages={vi.fn().mockResolvedValue([])}
      onCompact={vi.fn().mockResolvedValue(undefined)}
      onAddSessionReference={vi.fn().mockResolvedValue(undefined)}
      onRemoveSessionReference={vi.fn().mockResolvedValue(undefined)}
    />)

    const input = screen.getByRole('textbox', { name: '任务消息' })
    fireEvent.change(input, { target: { value: 'keep this draft' } })
    fireEvent.click(screen.getByRole('button', { name: '发送消息' }))

    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1))
    expect(onSend.mock.calls[0][0]).toMatchObject({ sessionId: 's1', text: 'keep this draft', imageDataUrls: [], skillIds: [], expertIds: [], referencedSessionIds: [] })
    expect(await screen.findByText(/内容已保留/)).toBeInTheDocument()
    expect(input).toHaveValue('keep this draft')
  })

  it('injects a selected expert team into the next send', async () => {
    window.ranparty.request = (async <T,>(method: string) => {
      if (method === 'skills.list') return { skills: [] } as T
      if (method === 'experts.list') return { teams: [{ schemaVersion: 1, id: 'team-1', name: '研究专家团', description: '并行研究', leaderSkillId: 'lead', memberSkillIds: ['member'], maxParallel: 3, source: 'test' }] } as T
      if (method === 'connectors.list') return { connectors: [] } as T
      return {} as T
    })
    const onSend = vi.fn().mockResolvedValue(undefined)
    const teamSession = { ...session, id: 'expert-team-session' }
    render(composer(teamSession, [teamSession], onSend))
    fireEvent.click(screen.getByRole('button', { name: '打开输入菜单' }))
    fireEvent.click(screen.getByRole('button', { name: /专家选择/ }))
    fireEvent.click(await screen.findByRole('button', { name: /研究专家团/ }))
    fireEvent.change(screen.getByRole('textbox', { name: '任务消息' }), { target: { value: '开始研究' } })
    fireEvent.click(screen.getByRole('button', { name: '发送消息' }))
    await waitFor(() => expect(onSend).toHaveBeenCalled())
    expect(onSend.mock.calls[0][0]).toMatchObject({ expertTeamId: 'team-1', expertIds: [] })
  })

  it('uses a synchronous lock to reject a duplicate send', async () => {
    let finishSend: (() => void) | undefined
    const onSend = vi.fn(() => new Promise<void>((resolve) => { finishSend = resolve }))
    render(composer(session, [session], onSend))
    fireEvent.change(screen.getByRole('textbox', { name: '任务消息' }), { target: { value: 'send once' } })
    const sendButton = screen.getByRole('button', { name: '发送消息' })

    fireEvent.click(sendButton)
    fireEvent.click(sendButton)

    expect(onSend).toHaveBeenCalledTimes(1)
    await act(async () => finishSend?.())
  })

  it('removes a selected Composer skill after a successful refresh hides it', async () => {
    let catalog = [skill]
    window.ranparty.request = async <T,>(method: string) => {
      if (method === 'skills.list') return { skills: catalog } as T
      if (method === 'connectors.list') return { connectors: [] } as T
      return {} as T
    }
    const onSend = vi.fn().mockResolvedValue(undefined)
    render(composer(session, [session], onSend))
    await waitFor(() => expect(window.ranparty.request).toBeDefined())
    fireEvent.click(screen.getByRole('button', { name: '打开输入菜单' }))
    fireEvent.click(screen.getByText('技能', { selector: 'strong' }).closest('button')!)
    fireEvent.click(await screen.findByRole('button', { name: /Alpha Skill/ }))
    expect(screen.getByText('技能：Alpha Skill')).toBeInTheDocument()

    catalog = []
    act(() => window.dispatchEvent(new CustomEvent('ranparty:skills-changed')))
    await waitFor(() => expect(screen.queryByText('技能：Alpha Skill')).not.toBeInTheDocument())
    fireEvent.change(screen.getByRole('textbox', { name: '任务消息' }), { target: { value: 'run safely' } })
    fireEvent.click(screen.getByRole('button', { name: '发送消息' }))
    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1))
    expect(onSend.mock.calls[0][0].skillIds).toEqual([])
  })

  it('creates a new task with its selected approval and mode without capability selection', async () => {
    const onCreate = vi.fn().mockResolvedValue(undefined)
    render(<NewTaskModal initialWorkspace="D:\\repo" workspaces={['D:\\repo']} profiles={[profile]} onClose={vi.fn()} onBrowse={vi.fn()} onCreate={onCreate} />)
    fireEvent.change(screen.getByPlaceholderText(/例如：/), { target: { value: 'create safely' } })
    fireEvent.click(screen.getByRole('button', { name: '请求批准' }))
    fireEvent.click(screen.getByRole('menuitemradio', { name: '自动通过后续操作' }))
    fireEvent.click(screen.getByRole('button', { name: '默认模式' }))
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'Plan' }))
    fireEvent.click(screen.getByRole('button', { name: '开始任务' }))
    await waitFor(() => expect(onCreate).toHaveBeenCalledTimes(1))
    expect(onCreate.mock.calls[0][0]).toMatchObject({
      prompt: 'create safely',
      approvalMode: 'auto',
      mode: 'plan',
      imageDataUrls: []
    })
    expect(onCreate.mock.calls[0][0]).not.toHaveProperty('skillIds')
  })

  it('fills a new task prompt from a quick start without creating a session', () => {
    const onCreate = vi.fn()
    render(<NewTaskModal initialWorkspace="D:\\repo" workspaces={['D:\\repo']} profiles={[profile]} onClose={vi.fn()} onBrowse={vi.fn()} onCreate={onCreate} />)

    fireEvent.click(screen.getByRole('button', { name: /规划实现/ }))
    expect(screen.getByRole('textbox', { name: '新任务描述' })).toHaveValue('请先分析当前需求和工作区，然后给出可执行的实现计划与验收步骤。')
    expect(onCreate).not.toHaveBeenCalled()
  })

  it('updates the preselected workspace when a workspace quick-create target changes', () => {
    const view = render(<NewTaskModal initialWorkspace="D:\\one" workspaces={['D:\\one', 'D:\\two']} profiles={[profile]} onClose={vi.fn()} onBrowse={vi.fn()} onCreate={vi.fn()} />)
    expect(screen.getAllByText(/one/).length).toBeGreaterThan(0)

    view.rerender(<NewTaskModal initialWorkspace="D:\\two" workspaces={['D:\\one', 'D:\\two']} profiles={[profile]} onClose={vi.fn()} onBrowse={vi.fn()} onCreate={vi.fn()} />)
    expect(screen.getAllByText(/two/).length).toBeGreaterThan(0)
  })

  it('keeps Plan actions disabled while acceptance is submitting', async () => {
    let finishAccept: (() => void) | undefined
    const onAccept = vi.fn(() => new Promise<void>((resolve) => { finishAccept = resolve }))
    render(<PlanCard plan={[{ step: 'Verify', status: 'pending' }]} actionable onAccept={onAccept} />)
    fireEvent.click(screen.getByRole('button', { name: '同意执行' }))

    expect(screen.getByRole('button', { name: '正在提交…' })).toBeDisabled()
    expect(screen.getByRole('button', { name: '修改计划' })).toBeDisabled()
    expect(onAccept).toHaveBeenCalledTimes(1)
    await act(async () => finishAccept?.())
    expect(screen.getByRole('button', { name: '同意执行' })).toBeEnabled()
  })

  it('does not clear the next session draft when the previous send resolves', async () => {
    let finishSend: (() => void) | undefined
    const onSend = vi.fn(() => new Promise<void>((resolve) => { finishSend = resolve }))
    const first = { ...session, id: 'async-first', title: 'First' }
    const second = { ...session, id: 'async-second', title: 'Second' }
    const view = render(composer(first, [first, second], onSend))

    fireEvent.change(screen.getByRole('textbox', { name: '任务消息' }), { target: { value: 'send from first' } })
    fireEvent.click(screen.getByRole('button', { name: '发送消息' }))
    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1))

    view.rerender(composer(second, [first, second], onSend))
    const secondInput = screen.getByRole('textbox', { name: '任务消息' })
    fireEvent.change(secondInput, { target: { value: 'keep second draft' } })
    await act(async () => finishSend?.())

    expect(secondInput).toHaveValue('keep second draft')
    view.unmount()
    render(composer(second, [first, second], onSend))
    expect(screen.getByRole('textbox', { name: '任务消息' })).toHaveValue('keep second draft')
  })

  it('restores a session draft and queued message after Composer remounts', async () => {
    const queuedSession = { ...session, id: 'persist-queue', title: 'Queued task', busy: true, turnState: 'running' as const }
    const onSend = vi.fn().mockResolvedValue(undefined)
    const view = render(composer(queuedSession, [queuedSession], onSend, true))
    const input = screen.getByRole('textbox', { name: '任务消息' })
    expect(input).toHaveAttribute('placeholder', expect.stringContaining('加入队列'))
    fireEvent.change(input, { target: { value: 'send this later' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(await screen.findByText('send this later')).toBeInTheDocument()

    view.unmount()
    render(composer(queuedSession, [queuedSession], onSend, true))
    expect(screen.getByText('send this later')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /移除发往 Queued task/ }))
  })

  it('opens Markdown web links through the safe external action', () => {
    const pathAction = vi.spyOn(window.ranparty, 'pathAction')
    render(<Transcript
      items={[{ type: 'assistant_message', id: 'link-message', status: 'completed', content: '[Open docs](https://example.test/docs)' }]}
      displayName="AI"
      onOpenPath={vi.fn()}
    />)

    fireEvent.click(screen.getByRole('link', { name: 'Open docs' }))
    expect(pathAction).toHaveBeenCalledWith('open', 'https://example.test/docs')
  })

  it('clears side-panel tabs and draft when switching sessions', () => {
    const first = { ...session, id: 'panel-first', title: 'First' }
    const second = { ...session, id: 'panel-second', title: 'Second' }
    const view = render(<RightPanel session={first} messages={[]} onClose={vi.fn()} onOpenPath={vi.fn()} onSendSide={vi.fn().mockResolvedValue(undefined)} />)
    fireEvent.click(screen.getByTitle('新建页签'))
    fireEvent.click(screen.getByRole('button', { name: '侧边对话' }))
    fireEvent.change(screen.getByRole('textbox', { name: '侧边对话消息' }), { target: { value: 'first-only draft' } })

    view.rerender(<RightPanel session={second} messages={[]} onClose={vi.fn()} onOpenPath={vi.fn()} onSendSide={vi.fn().mockResolvedValue(undefined)} />)
    expect(screen.queryByRole('textbox', { name: '侧边对话消息' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByTitle('新建页签'))
    fireEvent.click(screen.getByRole('button', { name: '侧边对话' }))
    expect(screen.getByRole('textbox', { name: '侧边对话消息' })).toHaveValue('')
  })
})

function composer(activeSession: Session, sessions: Session[], onSend: (envelope: SendEnvelope) => Promise<void>, busy?: boolean) {
  return <Composer
    busy={busy ?? activeSession.busy}
    session={activeSession}
    sessions={sessions}
    profiles={[profile]}
    workspaces={[activeSession.workspace]}
    contextUsed={0}
    contextWindow={128000}
    onSend={onSend}
    onStop={vi.fn()}
    onUpdate={vi.fn().mockResolvedValue(undefined)}
    onPickWorkspace={vi.fn().mockResolvedValue(undefined)}
    onChooseImages={vi.fn().mockResolvedValue([])}
    onCompact={vi.fn().mockResolvedValue(undefined)}
    onAddSessionReference={vi.fn().mockResolvedValue(undefined)}
    onRemoveSessionReference={vi.fn().mockResolvedValue(undefined)}
  />
}

const profile: Profile = {
  name: 'test', baseUrl: 'https://example.test', model: 'test-model', characterCard: '', characterDisplayName: 'AI',
  provider: 'openai', wireProtocol: 'chat_completions', supportsTools: true, supportsImages: true, supportsReasoning: true,
  contextWindow: 128000, maxOutputTokens: 8192, apiKeyConfigured: true,
}

const session: Session = {
  id: 's1', title: 'Test task', workspace: 'D:\\repo', profileName: 'test', model: 'test-model', displayName: 'AI',
  approvalMode: 'ask', permissionProfile: ':workspace', tokensIn: 0, tokensOut: 0, contextWindow: 128000,
  lastInputTokens: 0, contextTokens: 0, lastActive: new Date(0).toISOString(), busy: false, messages: [],
}

const skill = {
  id: 'skill-alpha', name: 'Alpha Skill', description: 'Test skill', source: 'workspace', pathLabel: 'skills/alpha',
}
