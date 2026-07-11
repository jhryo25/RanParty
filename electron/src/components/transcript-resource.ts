export function normalizeFileTarget(target: string) {
  if (/^file:\/\//i.test(target)) {
    try {
      const pathname = decodeURIComponent(new URL(target).pathname)
      return pathname.replace(/^\/([A-Za-z]:)/, '$1').replace(/\//g, '\\')
    } catch { return target }
  }
  return target.replace(/\//g, '\\')
}

export function safeResourceTarget(target: string) {
  const value = target.trim()
  if (!value || value.length > 4096) return ''
  if (/^https?:\/\//i.test(value)) {
    try {
      const parsed = new URL(value)
      return (parsed.protocol === 'http:' || parsed.protocol === 'https:') && !parsed.username && !parsed.password ? parsed.href : ''
    } catch { return '' }
  }
  return /^file:\/\/\/[A-Za-z]:\//i.test(value) || /^[A-Za-z]:[\\/]/.test(value) ? value : ''
}

export function isExternalResourceTarget(target: string) {
  return /^https?:\/\//i.test(target)
}

export function openExternalResource(target: string) {
  const safeTarget = safeResourceTarget(target)
  if (!safeTarget || !isExternalResourceTarget(safeTarget)) return Promise.reject(new Error('已阻止无效或不安全的外部链接'))
  return window.ranparty.pathAction('open', safeTarget)
}

export function resourceFileName(target: string) {
  return target.split(/[\\/]/).filter(Boolean).at(-1) ?? target
}
