import type { Bootstrap, RawMessage, Session, Settings } from './types'

type Listener = (event: string, data: unknown) => void

const settings: Settings = {
  activeProfileName: 'glm-5.2',
  profiles: [
    { name: 'glm-5.2', baseUrl: 'https://aigw.ds.163.com/v1', model: 'glm-5.2', characterCard: '', characterDisplayName: '小然', provider: 'openai', wireProtocol: 'chat_completions', supportsTools: true, supportsImages: true, supportsReasoning: true, contextWindow: 128000, maxOutputTokens: 8192, apiKeyConfigured: false },
    { name: 'DEEPSEEK', baseUrl: 'https://aigw.ds.163.com/v1', model: 'deepseek-v4-pro', characterCard: '', characterDisplayName: '小然', provider: 'openai', wireProtocol: 'chat_completions', supportsTools: true, supportsImages: false, supportsReasoning: true, contextWindow: 128000, maxOutputTokens: 8192, apiKeyConfigured: false },
  ],
  ioRoots: 'D:\\Projects\\AI_Product',
  shellMode: 'ask',
  contextWindow: 128000,
  compactThreshold: 80,
}

const sampleMessages: RawMessage[] = [
  { role: 'user', content: '请基于我们当前的产品定位，梳理核心功能模块，并给出优先级建议。' },
  { role: 'assistant', content: '## 一、产品定位回顾\n\n面向本地知识工作者的 AI 助手，强调数据本地化、可控性与工具执行能力。\n\n## 二、核心功能模块\n\n| 模块 | 目标 | 优先级 |\n| --- | --- | --- |\n| 对话与协作 | 多会话与上下文管理 | P0 |\n| 本地工具执行 | 文件、Excel、Word 与 Shell | P0 |\n| 知识与文件管理 | 结构化管理本地资产 | P1 |\n\n## 三、优先级建议\n\n- 近期：对话协作与本地工具执行\n- 中期：知识管理与内容生成\n- 远期：场景扩展能力' },
  { role: 'tool', content: '已读取 D:\\Projects\\AI_Product\\docs\\PRD_v0.3.md' },
]

const sessions: Session[] = [
  makeSession('demo-1', '产品规划讨论', 'D:\\Projects\\AI_Product', sampleMessages),
  makeSession('demo-2', '整理采访记录', 'D:\\Projects\\AI_Product', []),
  makeSession('demo-3', '本周迭代计划', 'D:\\Projects\\AI_Product', []),
  makeSession('demo-4', '素材结构整理', 'D:\\Projects\\Content', []),
]
sessions.forEach((session, index) => {
  session.lastActive = new Date(Date.now() - index * 60_000).toISOString()
})

function makeSession(id: string, title: string, workspace: string, messages: RawMessage[]): Session {
  return { id, title, workspace, profileName: 'glm-5.2', model: 'glm-5.2', displayName: '小然', approvalMode: 'ask', tokensIn: 20600, tokensOut: 1320, contextWindow: 128000, lastInputTokens: 20600, contextTokens: 21920, lastActive: new Date().toISOString(), busy: false, messages }
}

export function installMockBridge() {
  const listeners = new Set<Listener>()
  const emit = (event: string, data: unknown) => listeners.forEach((listener) => listener(event, data))
  window.ranparty = {
    async request<T>(method: string, params: Record<string, unknown> = {}) {
      if (method === 'app.bootstrap') return { sessions, settings, tools: [] } as T
      if (method === 'session.create') {
        const session = makeSession(`demo-${Date.now()}`, '新会话', String(params.workspace ?? ''), [])
        sessions.unshift(session); emit('session.created', session); return session as T
      }
      if (method === 'session.update') {
        const session = sessions.find((item) => item.id === params.sessionId)!
        const previousProfileName = session.profileName
        const previousModel = session.model
        Object.assign(session, params)
        if (typeof params.profileName === 'string') {
          const profile = settings.profiles.find((item) => item.name === params.profileName)
          if (profile) session.model = profile.model
        }
        emit('session.updated', session)
        if (previousProfileName !== session.profileName || previousModel !== session.model) {
          emit('message.added', {
            sessionId: session.id,
            message: { role: 'event', content: `已切换模型：${previousProfileName} · ${previousModel} → ${session.profileName} · ${session.model}` },
          })
        }
        return session as T
      }
      if (method === 'session.compact') {
        const session = sessions.find((item) => item.id === params.sessionId)!
        session.busy = true; emit('session.updated', session)
        await new Promise((resolve) => setTimeout(resolve, 350))
        session.contextTokens = 2840
        session.lastInputTokens = 2840
        session.busy = false; emit('session.updated', session)
        emit('context.compacted', { sessionId: session.id, profileName: params.profileName, contextTokens: session.contextTokens })
        return session as T
      }
      if (method === 'chat.send') {
        const session = sessions.find((item) => item.id === params.sessionId)!
        const user = { role: 'user', content: String(params.text) }
        emit('message.added', { sessionId: session.id, message: user })
        session.busy = true; emit('session.updated', session)
        const messageId = `mock-${Date.now()}`
        emit('assistant.started', { sessionId: session.id, messageId })
        if (params.text === '/mock-403') {
          setTimeout(() => {
            emit('chat.error', { sessionId: session.id, message: 'API 403: Your IP address is not allowed to access this resource.' })
            session.busy = false; emit('session.updated', session)
          }, 120)
          return { accepted: true } as T
        }
        setTimeout(() => emit('assistant.delta', { sessionId: session.id, messageId, delta: '收到。我会先梳理工作区内容，' }), 120)
        setTimeout(() => emit('assistant.delta', { sessionId: session.id, messageId, delta: '然后给出一份可执行的建议。' }), 260)
        setTimeout(() => {
          emit('assistant.completed', { sessionId: session.id, messageId, content: '收到。我会先梳理工作区内容，然后给出一份可执行的建议。', usageIn: 920, usageOut: 48, model: session.model })
          session.busy = false; emit('session.updated', session)
        }, 420)
        return { accepted: true } as T
      }
      if (method === 'chat.cancel') return { cancelled: true } as T
      if (method === 'settings.save') { Object.assign(settings, params); emit('settings.changed', settings); return settings as T }
      if (method === 'skills.list') return { skills: [{ id: 'mock-skill', name: 'product-planning', description: '产品规划与需求拆解工作流', source: '工作区', pathLabel: 'product-planning/SKILL.md' }] } as T
      if (method === 'profiles.save') {
        const draft = params.profile as typeof settings.profiles[number] & { apiKey?: string }
        const originalName = String(params.originalName ?? '')
        const index = settings.profiles.findIndex((profile) => profile.name === originalName)
        const { apiKey: _apiKey, ...profile } = draft
        const saved = { ...profile, apiKeyConfigured: draft.apiKeyConfigured || Boolean(draft.apiKey) }
        if (index >= 0) settings.profiles[index] = saved; else settings.profiles.push(saved)
        if (settings.activeProfileName === originalName) settings.activeProfileName = saved.name
        emit('settings.changed', settings); return settings as T
      }
      if (method === 'profiles.test') {
        const profile = params.profile as Settings['profiles'][number]
        const protocol = profile.provider === 'anthropic' ? 'Anthropic Messages' : profile.wireProtocol === 'responses' ? 'OpenAI Responses' : 'OpenAI Chat Completions'
        return { ok: true, latencyMs: 386, reply: 'OK', protocol } as T
      }
      if (method === 'profiles.models') return { models: ['kimi-k2.6', 'kimi-k2.7', 'kimi-k2-thinking', 'gpt-5.4-mini'], endpoint: 'mock://models' } as T
      if (method === 'workspace.files') return { files: [{ name: 'README.md', path: 'D:\\Projects\\AI_Product\\README.md', relativePath: 'README.md', isDirectory: false, size: 2048, lastWrite: new Date().toISOString() }, { name: 'docs', path: 'D:\\Projects\\AI_Product\\docs', relativePath: 'docs', isDirectory: true, size: 0, lastWrite: new Date().toISOString() }, { name: 'PRD.md', path: 'D:\\Projects\\AI_Product\\docs\\PRD.md', relativePath: 'docs\\PRD.md', isDirectory: false, size: 4096, lastWrite: new Date().toISOString() }] } as T
      if (method === 'profiles.setActive') { settings.activeProfileName = String(params.name); emit('settings.changed', settings); return settings as T }
      if (method === 'profiles.delete') { const index = settings.profiles.findIndex((profile) => profile.name === params.name); if (index >= 0) settings.profiles.splice(index, 1); settings.activeProfileName = settings.profiles[0]?.name ?? ''; emit('settings.changed', settings); return settings as T }
      if (method === 'characters.list') return { characters: [{ name: 'SOUL', displayName: '小然', path: 'RanParty/SOUL.md', isSoul: true }, { name: 'Assistant', displayName: '产品助手', path: 'RanParty/Characters/Assistant.md', isSoul: false }] } as T
      if (method === 'characters.read') return { name: params.name, content: '# Assistant\n\n你是 RanParty 的协作助手。' } as T
      if (method === 'characters.save' || method === 'characters.rename' || method === 'characters.delete' || method === 'approval.respond' || method === 'path.open') return { ok: true } as T
      if (method === 'qa.approval') {
        emit('approval.requested', {
          approvalId: 'qa-approval',
          sessionId: sessions[0].id,
          tool: 'ps_run',
          command: '.\\scripts\\deploy.ps1 -Environment Production -Force',
          workdir: 'D:\\Projects\\AI_Product\\scripts',
          reason: '部署当前应用到生产环境。',
        })
        return { ok: true } as T
      }
      throw new Error(`Mock method not implemented: ${method}`)
    },
    async chooseDirectory() { return 'D:\\Projects\\Selected' },
    async chooseImages() { return [] },
    onEvent(listener: Listener) { listeners.clear(); listeners.add(listener) },
  }
}
