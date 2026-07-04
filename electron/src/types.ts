export type RawContent = string | Array<{ type: string; text?: string; image_url?: { url: string } }>

export interface RawMessage {
  role: 'user' | 'assistant' | 'tool'
  content: RawContent
  tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }>
  tool_call_id?: string
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

export interface Attachment { name: string; dataUrl: string; size?: number }
export interface WorkspaceFile { name: string; path: string; relativePath: string; isDirectory: boolean; size: number; lastWrite: string }

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
    role: message.role,
    content: contentText(message.content),
    images: contentImages(message.content),
    toolName: message.role === 'tool' ? '工具结果' : undefined,
  }))
}
