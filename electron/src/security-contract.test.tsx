import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import mainSource from '../main.ts?raw'
import htmlSource from '../index.html?raw'
import packageSource from '../package.json?raw'
import { FileContextMenu } from './components/FileContextMenu'
import { RightPanel } from './components/RightPanel'
import { normalizeFileTarget, safeResourceTarget } from './components/transcript-resource'
import type { Session } from './types'

describe('Electron security contracts', () => {
  let request: ReturnType<typeof vi.fn>

  beforeEach(() => {
    request = vi.fn(async (method: string) => method === 'workspace.files' ? { files: [] } : {})
    window.ranparty = {
      isElectron: true,
      request: request as Window['ranparty']['request'],
      async chooseDirectory() { return null },
      async chooseImages() { return [] },
      async chooseFile() { return null },
      clipboardWrite: vi.fn(async () => ({ ok: true })),
      pathAction: vi.fn(async () => ({ ok: true })),
      onEvent() { return () => {} },
    }
  })

  it('routes local context-menu opens through the backend policy boundary', () => {
    const onClose = vi.fn()
    render(<FileContextMenu menu={{ target: 'D:\\workspace\\report.pdf', x: 10, y: 10 }} onClose={onClose} />)

    fireEvent.click(screen.getByRole('button', { name: '经工作区授权打开' }))

    expect(request).toHaveBeenCalledWith('path.open', { path: 'D:\\workspace\\report.pdf' })
    expect(window.ranparty.pathAction).not.toHaveBeenCalled()
  })

  it('uses the URL-only external action for web resources', () => {
    render(<FileContextMenu menu={{ target: 'https://example.test/docs', x: 10, y: 10 }} onClose={vi.fn()} />)

    fireEvent.click(screen.getByRole('button', { name: '在外部浏览器打开' }))

    expect(window.ranparty.pathAction).toHaveBeenCalledWith('open', 'https://example.test/docs')
    expect(request).not.toHaveBeenCalledWith('path.open', expect.anything())
  })

  it('keeps transcript resource parsing fail-closed after component extraction', () => {
    expect(safeResourceTarget('https://example.test/docs')).toBe('https://example.test/docs')
    expect(safeResourceTarget('https://user:secret@example.test/docs')).toBe('')
    expect(safeResourceTarget('javascript:alert(1)')).toBe('')
    expect(safeResourceTarget('relative/path.txt')).toBe('')
    expect(normalizeFileTarget('file:///D:/workspace/report.md')).toBe('D:\\workspace\\report.md')
  })

  it('pins browser guests to the hardened partition and rejects cleartext navigation', () => {
    render(<RightPanel session={testSession} messages={[]} onClose={vi.fn()} onOpenPath={vi.fn()} onSendSide={vi.fn().mockResolvedValue(undefined)} />)
    fireEvent.click(screen.getByTitle('新建页签'))
    fireEvent.click(screen.getByRole('button', { name: '浏览器' }))

    const guest = document.querySelector('webview')
    expect(guest).toHaveAttribute('partition', 'persist:ranparty-browser')
    expect(guest?.getAttribute('webpreferences')).toContain('sandbox=yes')
    expect(guest?.getAttribute('webpreferences')).toContain('nodeIntegration=no')
    expect(guest?.getAttribute('preload')).toBeNull()

    fireEvent.change(screen.getByRole('textbox', { name: '浏览器地址' }), { target: { value: 'http://example.test' } })
    fireEvent.click(screen.getByRole('button', { name: '前往' }))
    expect(screen.getByText('内置浏览器仅支持不含登录凭据的 HTTPS 链接')).toBeInTheDocument()
  })

  it('keeps main-process permissions deny-by-default and the renderer CSP strict', () => {
    const main = mainSource
    const html = htmlSource

    expect(main).toContain('setPermissionCheckHandler(() => false)')
    expect(main).toContain('setPermissionRequestHandler((_contents, _permission, callback) => callback(false))')
    expect(main).toContain("targetSession.on('will-download', (event) => event.preventDefault())")
    expect(main).toContain("browserSession.webRequest.onBeforeRequest({ urls: ['http://*/*'] }")
    expect(main).toContain("rendererSession.webRequest.onHeadersReceived({ urls: ['http://127.0.0.1:5173/*'] }")
    expect(main).toContain("params.partition = BROWSER_PARTITION")
    expect(main).toContain('delete webPreferences.preload')
    expect(main).toContain("contents.on('will-redirect', keepGuestOnHttps)")
    expect(main).toContain("const PATH_ACTIONS = new Set(['open'])")
    const safeOpenBlock = main.slice(main.indexOf('const SAFE_OPEN_EXTENSIONS'), main.indexOf('const BACKEND_METHOD_ALLOWLIST'))
    expect(safeOpenBlock).not.toContain("'.js'")
    expect(safeOpenBlock).not.toContain("'.html'")
    expect(safeOpenBlock).not.toContain("'.svg'")
    expect(safeOpenBlock).not.toContain("'.py'")
    expect(safeOpenBlock).not.toContain("'.doc'")
    expect(safeOpenBlock).not.toContain("'.xls'")
    expect(safeOpenBlock).not.toContain("'.ppt'")
    expect(safeOpenBlock).toContain("'.docx'")
    expect(safeOpenBlock).toContain("'.xlsx'")
    expect(safeOpenBlock).toContain("'.pptx'")
    expect(JSON.parse(packageSource).build.files).toContain('!dist-electron/preload.js')

    expect(html).toContain("script-src 'self'")
    expect(html).toContain("'sha256-Z2/iFzh9VMlVkEOar1f/oSHWwQk3ve1qk/C2WdsC4Xk='")
    expect(html).not.toContain("script-src 'unsafe-inline'")
    expect(html).not.toContain("'unsafe-eval'")
    expect(html).toContain('img-src \'self\' data: blob: https:')
    expect(html).toContain('ws://127.0.0.1:5173')
    const headerPolicy = main.match(/const RENDERER_CSP = "([^"]+)"/)?.[1]
    const metaPolicy = html.match(/http-equiv="Content-Security-Policy" content="([^"]+)"/)?.[1]
    expect(headerPolicy).toBe(metaPolicy)
  })
})

const testSession: Session = {
  id: 'security-session', title: 'Security', workspace: 'D:\\workspace', profileName: 'test', model: 'test', displayName: 'AI',
  approvalMode: 'ask', permissionProfile: ':workspace', tokensIn: 0, tokensOut: 0, contextWindow: 128000,
  lastInputTokens: 0, contextTokens: 0, lastActive: new Date(0).toISOString(), busy: false, messages: [],
}
