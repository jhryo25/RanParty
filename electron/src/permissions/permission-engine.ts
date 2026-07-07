// ============================================================
// Permission Engine — 权限 Profile 解析与决策引擎
// 参考 Codex permission profile 继承 + 3 级沙箱模式
// ============================================================

import type {
  ApprovalRequest,
  PermissionProfileConfig,
  PermissionProfileName,
} from '../types'
import { DEFAULT_PERMISSION_PROFILES } from '../types'

// ============================================================
// Profile 解析
// ============================================================

/** 解析权限 Profile（支持继承链 + 循环检测） */
export function resolvePermissionProfile(
  profileName: PermissionProfileName,
  customProfiles?: Record<string, PermissionProfileConfig>,
): PermissionProfileConfig {
  const visited = new Set<string>()
  const builtin = DEFAULT_PERMISSION_PROFILES[profileName]
  if (!builtin) throw new Error(`未知的权限 Profile: ${profileName}`)

  return mergeWithParents(builtin, customProfiles ?? {}, visited)
}

function mergeWithParents(
  config: PermissionProfileConfig,
  customProfiles: Record<string, PermissionProfileConfig>,
  visited: Set<string>,
): PermissionProfileConfig {
  if (visited.has(config.name)) {
    throw new Error(`权限 Profile 循环继承: ${[...visited, config.name].join(' -> ')}`)
  }
  visited.add(config.name)

  if (!config.extends) return { ...config }

  const parentName = config.extends
  const parentBuiltin = DEFAULT_PERMISSION_PROFILES[parentName as PermissionProfileName]
  const parentCustom = customProfiles[parentName]
  const parent = parentCustom ?? parentBuiltin
  if (!parent) throw new Error(`未找到父 Profile: ${parentName}`)

  const resolvedParent = mergeWithParents(parent, customProfiles, new Set(visited))

  return {
    name: config.name,
    fileSystem: {
      readRoots: [...new Set([...resolvedParent.fileSystem.readRoots, ...config.fileSystem.readRoots])],
      writeRoots: [...new Set([...resolvedParent.fileSystem.writeRoots, ...config.fileSystem.writeRoots])],
      deniedExtensions: [...new Set([...resolvedParent.fileSystem.deniedExtensions, ...config.fileSystem.deniedExtensions])],
    },
    commands: {
      allowedCommands: [...new Set([...(resolvedParent.commands.allowedCommands ?? []), ...(config.commands.allowedCommands ?? [])])],
      deniedCommands: [...new Set([...(resolvedParent.commands.deniedCommands ?? []), ...(config.commands.deniedCommands ?? [])])],
      requireApproval: [...new Set([...(resolvedParent.commands.requireApproval ?? []), ...(config.commands.requireApproval ?? [])])],
    },
    network: {
      allowedDomains: [...new Set([...resolvedParent.network.allowedDomains, ...config.network.allowedDomains])],
      allowAllExternal: resolvedParent.network.allowAllExternal || config.network.allowAllExternal,
    },
  }
}

// ============================================================
// 工具执行权限检查
// ============================================================

export interface PermissionCheckResult {
  allowed: boolean
  requiresApproval: boolean
  reason?: string
  autoReview?: {
    risk: 'low' | 'medium' | 'high'
    summary: string
  }
}

/** 检查工具执行是否被当前 Profile 允许 */
export function checkToolPermission(
  profile: PermissionProfileConfig,
  approval: ApprovalRequest,
): PermissionCheckResult {
  const { tool, command, workdir } = approval

  // 1. 检查是否是命令执行
  if (tool === 'shell_run' || tool === 'ps_run') {
    return checkCommandPermission(profile, command)
  }

  // 2. 检查文件操作
  if (tool.startsWith('file_')) {
    return checkFilePermission(profile, command || workdir)
  }

  // 3. 网络操作
  if (tool === 'web_search' || tool === 'web_fetch') {
    return checkNetworkPermission(profile, command)
  }

  // 4. :read-only profile 拒绝所有写入类工具
  if (profile.name === ':read-only') {
    const writeTools = ['file_write', 'file_append', 'file_replace', 'file_move', 'file_delete', 'shell_run', 'ps_run']
    if (writeTools.includes(tool)) {
      return { allowed: false, requiresApproval: true, reason: `只读模式下不允许执行 ${tool}` }
    }
  }

  return { allowed: true, requiresApproval: false }
}

function checkCommandPermission(
  profile: PermissionProfileConfig,
  command: string,
): PermissionCheckResult {
  // 检查黑名单
  for (const pattern of profile.commands.deniedCommands ?? []) {
    try {
      if (new RegExp(pattern, 'i').test(command)) {
        return {
          allowed: false,
          requiresApproval: true,
          reason: `命令被黑名单规则 "${pattern}" 拦截`,
        }
      }
    } catch { /* 无效正则跳过 */ }
  }

  // 检查需审批列表
  for (const pattern of profile.commands.requireApproval ?? []) {
    try {
      if (new RegExp(pattern, 'i').test(command)) {
        return {
          allowed: true,
          requiresApproval: true,
          reason: `命令匹配审批规则 "${pattern}"`,
          autoReview: assessCommandRisk(command),
        }
      }
    } catch { /* 无效正则跳过 */ }
  }

  // 如果有白名单，检查是否匹配
  const whitelist = profile.commands.allowedCommands ?? []
  if (whitelist.length > 0) {
    const matched = whitelist.some((pattern) => {
      try { return new RegExp(pattern, 'i').test(command) }
      catch { return false }
    })
    if (!matched) {
      return {
        allowed: true,
        requiresApproval: true,
        reason: '命令不在白名单中，需要审批',
        autoReview: assessCommandRisk(command),
      }
    }
  }

  return { allowed: true, requiresApproval: profile.name !== ':danger-full-access' }
}

function checkFilePermission(
  profile: PermissionProfileConfig,
  path: string,
): PermissionCheckResult {
  const ext = path.split('.').pop()?.toLowerCase() ?? ''
  if (profile.fileSystem.deniedExtensions.includes(`.${ext}`)) {
    return {
      allowed: false,
      requiresApproval: false,
      reason: `禁止操作 .${ext} 文件（安全策略）`,
    }
  }
  return { allowed: true, requiresApproval: false }
}

function checkNetworkPermission(
  profile: PermissionProfileConfig,
  url: string,
): PermissionCheckResult {
  if (profile.network.allowAllExternal) return { allowed: true, requiresApproval: false }
  if (profile.network.allowedDomains.length === 0) {
    return { allowed: true, requiresApproval: true, reason: '网络访问需要审批' }
  }
  try {
    const hostname = new URL(url).hostname
    const allowed = profile.network.allowedDomains.some((d) => hostname === d || hostname.endsWith(`.${d}`))
    if (!allowed) {
      return { allowed: true, requiresApproval: true, reason: `域名 ${hostname} 不在白名单中` }
    }
  } catch { /* URL 无效，仍然允许但需审批 */ }
  return { allowed: true, requiresApproval: false }
}

/** 评估命令风险等级 */
function assessCommandRisk(command: string): { risk: 'low' | 'medium' | 'high'; summary: string } {
  const highRisk = ['rm -rf', 'del /F', 'format', 'fdisk', '> /dev/', 'dd if=', 'mkfs.']
  const mediumRisk = ['sudo', 'chmod 777', 'chown', 'kill', 'taskkill', 'net user', 'reg ']
  const cmd = command.toLowerCase()

  if (highRisk.some((p) => cmd.includes(p))) {
    return { risk: 'high', summary: '此命令可能造成不可逆的数据丢失或系统损坏' }
  }
  if (mediumRisk.some((p) => cmd.includes(p))) {
    return { risk: 'medium', summary: '此命令涉及系统权限变更或进程管理' }
  }
  return { risk: 'low', summary: '常规命令' }
}
