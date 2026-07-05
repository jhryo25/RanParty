export type RawContent = string | Array<{ type: string; text?: string; image_url?: { url: string } }>

export interface RawMessage {
  role: 'user' | 'assistant' | 'tool' | 'event' | 'system'
  content: RawContent
  tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }>
  tool_call_id?: string
  name?: string
  arguments?: string
  path?: string
  is_error?: boolean
}

export interface Session {
  id: string
  title: string
  workspace: string
  profileName: string
  model: string
  displayName: string
  approvalMode: 'ask' | 'auto'
  tokensIn: number
  tokensOut: number
  contextWindow: number
  lastInputTokens: number
  contextTokens: number
  lastActive: string
  busy: boolean
  messages: RawMessage[]
}

export interface Profile {
  name: string
  baseUrl: string
  model: string
  characterCard: string
  characterDisplayName: string
  provider: 'openai' | 'anthropic'
  wireProtocol: 'chat_completions' | 'responses' | 'anthropic_messages'
  supportsTools: boolean
  supportsImages: boolean
  supportsReasoning: boolean
  contextWindow: number
  maxOutputTokens: number
  apiKeyConfigured: boolean
}

export interface Settings {
  activeProfileName: string
  profiles: Profile[]
  ioRoots: string
  shellMode: 'ask' | 'auto'
  contextWindow: number
  compactThreshold: number
}

export interface Skill {
  id: string
  name: string
  description: string
  source: string
  pathLabel: string
}

export interface MarketplaceSkill {
  id: string
  slug?: string
  name: string
  description: string
  pluginName: string
  marketplace: string
  publisher: string
  category: string
  version: string
  installed: boolean
  iconUrl?: string
  downloads?: number
  stars?: number
  requiresApiKey?: boolean
  source?: string
}

export interface Attachment { name: string; dataUrl: string; size?: number }
export interface WorkspaceFile { name: string; path: string; relativePath: string; isDirectory: boolean; size: number; lastWrite: string }
export interface FilePreview { path: string; name: string; extension: string; size: number; lastWrite: string; kind: 'html' | 'markdown' | 'text' | 'image' | 'pdf' | 'unsupported' | 'too_large'; content?: string; dataUrl?: string; limit?: number }

export interface Bootstrap {
  sessions: Session[]
  settings: Settings
  tools: string[]
}

export interface ApprovalRequest {
  approvalId: string
  sessionId: string
  tool: string
  command: string
  workdir: string
  reason: string
}

export interface UiMessage {
  id: string
  role: 'user' | 'assistant' | 'tool' | 'system'
  content: string
  images?: string[]
  reasoning?: string
  streaming?: boolean
  toolName?: string
  toolArguments?: string
  toolPath?: string
  toolError?: boolean
  agentName?: string
  hasToolCalls?: boolean
  usageIn?: number
  usageOut?: number
  model?: string
  error?: boolean
}

export function contentText(content: RawContent): string {
  if (typeof content === 'string') return content
  return content.find((item) => item.type === 'text')?.text ?? ''
}

export function contentImages(content: RawContent): string[] {
  if (typeof content === 'string') return []
  return content.flatMap((item) => item.type === 'image_url' && item.image_url?.url ? [item.image_url.url] : [])
}

export function toUiMessages(messages: RawMessage[]): UiMessage[] {
  return messages.map((message, index) => ({
    id: `history_${index}`,
    role: message.role === 'event' ? 'system' : message.role,
    content: contentText(message.content),
    images: contentImages(message.content),
    toolName: message.role === 'tool' ? (message.name || '工具结果') : undefined,
    toolArguments: message.role === 'tool' ? message.arguments : undefined,
    toolPath: message.role === 'tool' ? message.path : undefined,
    toolError: message.role === 'tool' ? Boolean(message.is_error) : undefined,
    agentName: message.role === 'tool' && message.name === 'delegate_agent' ? agentNameFromArguments(message.arguments) : undefined,
    hasToolCalls: message.role === 'assistant' && Boolean(message.tool_calls?.length),
  }))
}

function agentNameFromArguments(value = '') {
  try { return String(JSON.parse(value).profileName || '') } catch { return '' }
}
