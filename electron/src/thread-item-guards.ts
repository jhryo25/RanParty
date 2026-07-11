import type {
  AssistantMessageItem,
  ContextCompactionItem,
  ErrorItem,
  FileChangeItem,
  PlanStepItem,
  SystemNoticeItem,
  ThreadItem,
  ToolCallItem,
  ToolResultItem,
  UserMessageItem,
} from './types'

export const isUserMessage = (item: ThreadItem): item is UserMessageItem => item.type === 'user_message'
export const isAssistantMessage = (item: ThreadItem): item is AssistantMessageItem => item.type === 'assistant_message'
export const isToolCall = (item: ThreadItem): item is ToolCallItem => item.type === 'tool_call'
export const isToolResult = (item: ThreadItem): item is ToolResultItem => item.type === 'tool_result'
export const isFileChange = (item: ThreadItem): item is FileChangeItem => item.type === 'file_change'
export const isPlanStep = (item: ThreadItem): item is PlanStepItem => item.type === 'plan_step'
export const isError = (item: ThreadItem): item is ErrorItem => item.type === 'error'
export const isContextCompaction = (item: ThreadItem): item is ContextCompactionItem => item.type === 'context_compaction'
export const isSystemNotice = (item: ThreadItem): item is SystemNoticeItem => item.type === 'system_notice'
export const hasToolPath = (item: ThreadItem): item is ToolResultItem & { toolPath: string } => item.type === 'tool_result' && item.toolPath != null
