import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ConnectorSettings } from './ConnectorSettings'

describe('connector settings', () => {
  const request = vi.fn(async (method: string, params?: unknown): Promise<unknown> => {
    if (method === 'connectors.list') return { connectors: [] }
    if (method === 'connectors.save') return { connector: { ...(params as { connector: object }).connector, id: 'mcp_test' }, connectors: [] }
    return {}
  })

  beforeEach(() => {
    request.mockClear()
    window.ranparty = {
      isElectron: false,
      request: async <T = unknown,>(method: string, params?: Record<string, unknown>) => await request(method, params) as T,
      async chooseDirectory() { return null }, async chooseImages() { return [] }, async chooseFile() { return null }, async chooseFileData() { return [] },
      async choosePetPackage() { return null },
      async clipboardWrite() { return { ok: true } }, async pathAction() { return { ok: true } }, onEvent() { return () => {} },
    }
  })

  it('keeps new connectors disabled until the user explicitly enables them', async () => {
    render(<ConnectorSettings />)
    await waitFor(() => expect(request).toHaveBeenCalledWith('connectors.list', {}))
    fireEvent.change(screen.getByLabelText('名称'), { target: { value: 'Local MCP' } })
    fireEvent.change(screen.getByLabelText('命令'), { target: { value: 'node' } })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))

    await waitFor(() => expect(request).toHaveBeenCalledWith('connectors.save', expect.objectContaining({ connector: expect.objectContaining({ name: 'Local MCP', command: 'node', enabled: false }) })))
  })
})
