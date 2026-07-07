// ============================================================
// Hook Runtime — 生命周期钩子执行引擎
// 参考 Codex hook_runtime.rs 设计
// ============================================================

import type { HookConfig, HookEventType, HookOutput } from '../types'

/** 单次 Hook 调用请求 */
export interface HookInvocation {
  event: HookEventType
  toolName?: string
  toolArguments?: string
  sessionId: string
  workdir: string
  metadata?: Record<string, unknown>
}

/** Hook 执行结果 */
export interface HookExecutionResult {
  hookName: string
  output: HookOutput
  durationMs: number
}

/** 全局 Hook 执行：按优先级运行所有匹配的 hooks，收集结果 */
export async function executeHooks(
  configs: HookConfig[],
  invocation: HookInvocation,
): Promise<HookExecutionResult[]> {
  const matched = configs.filter((config) => {
    if (!config.enabled) return false
    if (config.event !== invocation.event) return false
    if (config.matcher && invocation.toolName) {
      try {
        return new RegExp(config.matcher, 'i').test(invocation.toolName)
      } catch {
        return false
      }
    }
    return true
  })

  const results: HookExecutionResult[] = []
  for (const config of matched) {
    const start = performance.now()
    let output: HookOutput
    try {
      output = await executeSingleHook(config, invocation)
    } catch (error) {
      output = {
        action: 'warn',
        message: `Hook "${config.name}" 执行异常: ${error instanceof Error ? error.message : String(error)}`,
      }
    }
    const durationMs = Math.round(performance.now() - start)
    results.push({ hookName: config.name, output, durationMs })

    // 如果 hook 返回 block，立即终止后续 hooks
    if (output.action === 'block') break
  }
  return results
}

/** 执行单个 Hook */
async function executeSingleHook(
  config: HookConfig,
  invocation: HookInvocation,
): Promise<HookOutput> {
  switch (config.handler) {
    case 'prompt':
      // prompt handler: 返回注入的上下文内容
      if (!config.prompt) return { action: 'allow' }
      return {
        action: 'inject_context',
        injectedContext: config.prompt,
      }

    case 'command': {
      // command handler: 通过 IPC 调用主进程执行 shell 命令
      const command = (window as unknown as { ranparty?: { hookExec?: (cmd: string, timeout: number, env: Record<string, string>) => Promise<string> } }).ranparty?.hookExec
      if (!command) {
        return {
          action: 'warn',
          message: `Hook "${config.name}": 主进程 hook 执行器不可用`,
        }
      }
      const cmd = (config.commandWindows ?? config.command) ?? ''
      if (!cmd) return { action: 'allow' }

      const env = {
        RANPARTY_HOOK_EVENT: invocation.event,
        RANPARTY_HOOK_TOOL: invocation.toolName ?? '',
        RANPARTY_HOOK_SESSION: invocation.sessionId,
        RANPARTY_HOOK_WORKDIR: invocation.workdir,
      }
      const result = await command(cmd, config.timeout, env)
      return parseCommandOutput(result)
    }

    case 'agent':
      // agent handler: 委托给子 agent（v2 预留）
      return { action: 'allow' }

    default:
      return { action: 'allow' }
  }
}

/** 解析 command handler 的 JSON 输出 */
function parseCommandOutput(raw: string): HookOutput {
  try {
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed.action === 'string') {
      return {
        action: parsed.action,
        message: parsed.message,
        changes: parsed.changes,
        injectedContext: parsed.injectedContext ?? parsed.inject_context,
      }
    }
  } catch { /* 非 JSON 输出，当作普通文本 */ }
  return { action: 'warn', message: raw.slice(0, 500) }
}

/** 从 Hook 执行结果中提取最终决策 */
export function reduceHookResults(
  results: HookExecutionResult[],
): { allowed: boolean; reason?: string; injectedContexts: string[] } {
  const injectedContexts: string[] = []
  for (const result of results) {
    switch (result.output.action) {
      case 'block':
        return {
          allowed: false,
          reason: result.output.message || `被 Hook "${result.hookName}" 拦截`,
          injectedContexts,
        }
      case 'inject_context':
        if (result.output.injectedContext) {
          injectedContexts.push(result.output.injectedContext)
        }
        break
      case 'warn':
        // 警告不阻止执行，但记录
        console.warn(`[Hook] ${result.hookName}: ${result.output.message}`)
        break
    }
  }
  return { allowed: true, injectedContexts }
}

// ============================================================
// 内置 Hooks
// ============================================================

/** 文件守护 Hook 配置 */
export const FILE_GUARDIAN_HOOK: HookConfig = {
  name: 'builtin:file-guardian',
  event: 'tool.pre_use',
  matcher: 'file_write|file_append|file_replace|file_move|shell_run|ps_run',
  handler: 'prompt',
  prompt:
    '在修改或删除文件前，请确认操作不会导致数据丢失。对于 .exe, .dll, .sys 等二进制文件，绝对不要修改或删除。对于配置文件，建议先备份。',
  timeout: 5000,
  enabled: true,
  source: 'builtin',
}

/** 网络守护 Hook 配置 */
export const NETWORK_GUARDIAN_HOOK: HookConfig = {
  name: 'builtin:network-guardian',
  event: 'tool.pre_use',
  matcher: 'web_fetch|web_search',
  handler: 'prompt',
  prompt: '访问外部 URL 时，请确保不发送敏感信息（API 密钥、内部路径、用户数据）。避免访问已知恶意域名。',
  timeout: 5000,
  enabled: true,
  source: 'builtin',
}

/** 所有内置 hooks */
export const BUILTIN_HOOKS: HookConfig[] = [
  FILE_GUARDIAN_HOOK,
  NETWORK_GUARDIAN_HOOK,
]
