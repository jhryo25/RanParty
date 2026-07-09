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
  permissionProfile: ':workspace' as const,
}

const sampleMessages: RawMessage[] = [
  { role: 'user', content: '请基于我们当前的产品定位，梳理核心功能模块，并给出优先级建议。' },
  { role: 'assistant', content: '', tool_calls: [{ id: 'mock-agent-call', function: { name: 'delegate_agent', arguments: '{"profileName":"产品专家","task":"独立审查功能优先级"}' } }, { id: 'mock-file-call', function: { name: 'file_write', arguments: '{"path":"D:\\\\Projects\\\\AI_Product\\\\output\\\\priority-report.html"}' } }] },
  { role: 'tool', name: 'delegate_agent', arguments: '{"profileName":"产品专家","task":"独立审查功能优先级"}', tool_call_id: 'mock-agent-call', content: '产品专家建议优先完成对话协作与本地工具执行。' },
  { role: 'tool', name: 'file_write', arguments: '{"path":"D:\\\\Projects\\\\AI_Product\\\\output\\\\priority-report.html"}', path: 'D:\\Projects\\AI_Product\\output\\priority-report.html', tool_call_id: 'mock-file-call', content: 'OK' },
  { role: 'assistant', content: '## 已完成梳理\n\n我结合产品专家的独立审查，建议按以下顺序推进：\n\n- P0：对话与协作、本地工具执行\n- P1：知识与文件管理\n- P2：更多场景扩展\n\n关键结论已经合并到当前回复中。' },
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
  return { id, title, workspace, profileName: 'glm-5.2', model: 'glm-5.2', displayName: '小然', approvalMode: 'ask', permissionProfile: ':workspace', tokensIn: 20600, tokensOut: 1320, contextWindow: 128000, lastInputTokens: 20600, contextTokens: 21920, lastActive: new Date().toISOString(), busy: false, messages }
}

export function installMockBridge() {
  const listeners = new Set<Listener>()
  const emit = (event: string, data: unknown) => listeners.forEach((listener) => listener(event, data))
  window.ranparty = {
    isElectron: false,
    async request<T>(method: string, params: Record<string, unknown> = {}) {
      if (method === 'app.bootstrap') return { sessions, settings, tools: [] } as T
      if (method === 'session.create') {
        const session = makeSession(`demo-${Date.now()}`, '新会话', String(params.workspace ?? ''), [])
        sessions.unshift(session); emit('session.created', session); return session as T
      }
      if (method === 'session.update') {
        const session = sessions.find((item) => item.id === params.sessionId)
        if (!session) throw new Error(`Session not found: ${params.sessionId}`)
        const previousProfileName = session.profileName
        const previousModel = session.model
        const previousMode = session.mode ?? 'default'
        Object.assign(session, params)
        if (typeof params.profileName === 'string') {
          const profile = settings.profiles.find((item) => item.name === params.profileName)
          if (profile) session.model = profile.model
        }
        emit('session.updated', session)
        if (typeof params.mode === 'string' && (session.mode ?? 'default') !== previousMode) {
          const modeText = session.mode === 'plan'
            ? '已切换到 Plan 模式：本轮只输出计划，不执行工具或本地副作用。'
            : session.mode === 'ask'
              ? '已切换到 Ask 模式：仅回答问题，不调用工具、不写文件。'
              : session.mode === 'goal'
                ? '已切换到 Goal 模式：围绕一个持久目标推进。'
                : '已切换到默认模式：可以在审批约束下使用工具完成任务。'
          emit('message.added', {
            sessionId: session.id,
            message: { role: 'event', event: 'mode_changed', content: modeText, mode: session.mode ?? 'default' },
          })
        }
        if (previousProfileName !== session.profileName || previousModel !== session.model) {
          emit('message.added', {
            sessionId: session.id,
            message: { role: 'event', content: `已切换模型：${previousProfileName} · ${previousModel} → ${session.profileName} · ${session.model}` },
          })
        }
        return session as T
      }
      if (method === 'session.compact') {
        const session = sessions.find((item) => item.id === params.sessionId)
        if (!session) throw new Error(`Session not found: ${params.sessionId}`)
        session.busy = true; emit('session.updated', session)
        await new Promise((resolve) => setTimeout(resolve, 350))
        session.contextTokens = 2840
        session.lastInputTokens = 2840
        session.busy = false; emit('session.updated', session)
        emit('message.added', { sessionId: session.id, message: { role: 'event', event: 'context_compacted', content: '上下文已手动总结（21.9K → 2.8K Token）' } })
        emit('context.compacted', { sessionId: session.id, automatic: false, profileName: params.profileName, contextTokens: session.contextTokens })
        return session as T
      }
      if (method === 'chat.send') {
        const session = sessions.find((item) => item.id === params.sessionId)
        if (!session) throw new Error(`Session not found: ${params.sessionId}`)
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
      if (method === 'skills.marketplace.list') return { items: [{ id: 'market-project-brief', name: 'project-brief', description: '读取工作区并生成有文件依据的项目简报、风险与下一步计划。', pluginName: 'RanParty 工作流', marketplace: 'RanParty 官方市场', publisher: 'RanParty', category: 'Productivity', version: '1.0.0', installed: false }] } as T
      if (method === 'skills.marketplace.install' || method === 'skills.marketplace.uninstall') return { installed: method === 'skills.marketplace.install' } as T
      if (method === 'skills.skillhub.list') return { items: [
        { id: 'skillhub:find-skills', slug: 'find-skills', name: 'Find Skills', description: '帮助用户发现和安装适合当前任务的智能体技能。', pluginName: 'SkillHub', marketplace: 'SkillHub', publisher: 'root', category: 'ai-agent', version: '1.0.0', installed: true, downloads: 579490, stars: 1521, requiresApiKey: false },
        { id: 'skillhub:browser-use', slug: 'browser-use', name: 'Browser Use', description: '自动化浏览器交互，用于网页测试、表单填写、截图和数据提取。', pluginName: 'SkillHub', marketplace: 'SkillHub', publisher: 'shawnpana', category: 'ai-agent', version: '2.0.1', installed: false, downloads: 73499, stars: 147, requiresApiKey: false },
        { id: 'skillhub:summarize', slug: 'summarize', name: '智能摘要', description: '为长文本、文档和网页生成摘要，提取核心要点。', pluginName: 'SkillHub', marketplace: 'SkillHub', publisher: 'paudyyin', category: 'knowledge-management', version: '1.0.0', installed: false, downloads: 524551, stars: 972, requiresApiKey: true },
        { id: 'skillhub:tencent-docs', slug: 'tencent-docs', name: '腾讯文档', description: '创建、编辑、搜索和管理腾讯在线文档。', pluginName: 'SkillHub', marketplace: 'SkillHub', publisher: 'Tencent', category: 'office-efficiency', version: '1.0.40', installed: false, downloads: 127661, stars: 180, requiresApiKey: true },
        { id: 'skillhub:github', slug: 'github', name: 'GitHub', description: '使用 gh CLI 管理 Issue、PR、CI 与仓库任务。', pluginName: 'SkillHub', marketplace: 'SkillHub', publisher: 'steipete', category: 'dev-programming', version: '1.0.0', installed: false, downloads: 331450, stars: 687, requiresApiKey: true },
        { id: 'skillhub:skill-vetter', slug: 'skill-vetter', name: 'Skill Vetter', description: '安装前检查 Skill 的权限范围、风险信号与可疑模式。', pluginName: 'SkillHub', marketplace: 'SkillHub', publisher: 'spclaudehome', category: 'ai-agent', version: '1.0.0', installed: false, downloads: 273894, stars: 1254, requiresApiKey: false },
      ] } as T
      if (method === 'skills.skillhub.install' || method === 'skills.skillhub.uninstall') return { installed: method === 'skills.skillhub.install' } as T
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
      if (method === 'path.preview') { const path = String(params.path); const html = path.endsWith('.html'); return { path, name: path.split(/[\\\\/]/).at(-1), extension: html ? '.html' : '.md', size: 4096, lastWrite: new Date().toISOString(), kind: html ? 'html' : 'markdown', content: html ? '<main style="font-family:sans-serif;padding:28px"><h1>优先级报告</h1><p>这是 RanParty 生成的 HTML 产物预览。</p></main>' : '# 工作区文件\n\n这是右侧面板的 Markdown 预览。' } as T }
      if (method === 'profiles.setActive') { settings.activeProfileName = String(params.name); emit('settings.changed', settings); return settings as T }
      if (method === 'profiles.delete') { const index = settings.profiles.findIndex((profile) => profile.name === params.name); if (index >= 0) settings.profiles.splice(index, 1); settings.activeProfileName = settings.profiles[0]?.name ?? ''; emit('settings.changed', settings); return settings as T }
      if (method === 'characters.list') return { characters: [{ name: 'SOUL', displayName: '小然', path: 'RanParty/SOUL.md', isSoul: true }, { name: 'Assistant', displayName: '产品助手', path: 'RanParty/Characters/Assistant.md', isSoul: false }] } as T
      if (method === 'characters.read') return { name: params.name, content: '# Assistant\n\n你是 RanParty 的协作助手。' } as T
      if (method === 'characters.save' || method === 'characters.rename' || method === 'characters.delete' || method === 'approval.respond' || method === 'clarification.respond' || method === 'path.open') return { ok: true } as T
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
    async chooseFile() { return null },
    async clipboardWrite() { return { ok: true } },
    async pathAction() { return { ok: true } },
    onEvent(listener: Listener) { listeners.clear(); listeners.add(listener) },
  }
}
