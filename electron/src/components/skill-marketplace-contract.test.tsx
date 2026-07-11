import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { MarketplaceSkill } from '../types'
import { SkillMarketplace } from './SkillMarketplace'

describe('Skill Marketplace interaction contracts', () => {
  beforeEach(() => {
    window.ranparty = {
      isElectron: false,
      async request<T>() { return {} as T },
      async chooseDirectory() { return null },
      async chooseImages() { return [] },
      async chooseFile() { return null },
      async clipboardWrite() { return { ok: true } },
      async pathAction() { return { ok: true } },
      onEvent() { return () => {} },
    }
  })

  it('ignores an older list response after a newer request wins', async () => {
    const first = deferred<{ items: MarketplaceSkill[] }>()
    const second = deferred<{ items: MarketplaceSkill[] }>()
    let calls = 0
    window.ranparty.request = (async <T,>(method: string) => {
      if (method !== 'skills.skillhub.list') return {} as T
      calls++
      return await (calls === 1 ? first.promise : second.promise) as T
    }) as typeof window.ranparty.request
    render(<SkillMarketplace onClose={vi.fn()} workspace="D:\\repo" />)

    fireEvent.click(screen.getByRole('button', { name: '下载热榜' }))
    await waitFor(() => expect(calls).toBe(2))
    await act(async () => second.resolve({ items: [marketSkill('new-skill', 'New result')] }))
    expect(await screen.findByText('New result')).toBeInTheDocument()
    await act(async () => first.resolve({ items: [marketSkill('old-skill', 'Old result')] }))

    expect(screen.getByText('New result')).toBeInTheDocument()
    expect(screen.queryByText('Old result')).not.toBeInTheDocument()
  })

  it('tracks concurrent mutations independently', async () => {
    const first = deferred<unknown>()
    const second = deferred<unknown>()
    const items = [marketSkill('one', 'One', true), marketSkill('two', 'Two', true)]
    window.ranparty.request = (async <T,>(method: string, params?: Record<string, unknown>) => {
      if (method === 'skills.skillhub.list') return { items } as T
      if (method === 'skills.skillhub.uninstall') return await (params?.id === items[0].id ? first.promise : second.promise) as T
      return {} as T
    }) as typeof window.ranparty.request
    render(<SkillMarketplace onClose={vi.fn()} />)
    const uninstallOne = await screen.findByRole('button', { name: '卸载 One' })
    const uninstallTwo = screen.getByRole('button', { name: '卸载 Two' })

    fireEvent.click(uninstallOne)
    fireEvent.click(uninstallTwo)

    expect(uninstallOne).toBeDisabled()
    expect(uninstallTwo).toBeDisabled()
    await act(async () => first.resolve({ ok: true }))
    expect(uninstallTwo).toBeDisabled()
    await act(async () => second.resolve({ ok: true }))
    await waitFor(() => expect(screen.getByRole('button', { name: '安装 One' })).toBeEnabled())
  })

  it('binds installation to a structured, sanitized package identity', async () => {
    const item = { ...marketSkill('safe-skill', 'Catalog\u0000 Name'), publisher: 'Publisher\u202E spoof' }
    const requests: Array<{ method: string; params?: Record<string, unknown> }> = []
    const confirmSpy = vi.spyOn(window, 'confirm')
    window.ranparty.request = (async <T,>(method: string, params?: Record<string, unknown>) => {
      requests.push({ method, params })
      if (method === 'skills.skillhub.list') return { items: [item] } as T
      if (method === 'skills.skillhub.preview') return {
        id: item.id,
        slug: item.slug,
        name: 'Package\u0007 Name\u2066',
        description: '',
        version: '1.0.0',
        trust: 'community',
        invocationPolicy: 'explicit_only',
        fileCount: 2,
        totalBytes: 2048,
        allowedTools: ['file_read\u0000'],
        scriptFiles: ['scripts/run.ps1\u202E'],
        scriptFileCount: 25,
        scriptFilesTruncated: true,
        contentPreview: 'Review\u0007 this\ncarefully\u202E',
        archiveSha256: 'a'.repeat(64),
        confirmationToken: 'b'.repeat(32),
        confirmationExpiresAt: new Date(Date.now() + 60_000).toISOString(),
      } as T
      return { ok: true } as T
    }) as typeof window.ranparty.request
    render(<SkillMarketplace onClose={vi.fn()} />)

    fireEvent.click(await screen.findByRole('button', { name: '安装 Catalog Name' }))
    const dialog = await screen.findByRole('alertdialog')
    expect(dialog).toHaveTextContent('目录名称')
    expect(dialog).toHaveTextContent('包内名称')
    expect(dialog).toHaveTextContent('目录声明')
    expect(dialog).toHaveTextContent('仅显示前 1 个，共 25 个')
    expect(dialog.textContent).not.toMatch(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u061c\u202a-\u202e\u2066-\u2069]/)
    expect(confirmSpy).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: '确认安装此摘要' }))
    await waitFor(() => expect(requests.find((entry) => entry.method === 'skills.skillhub.install')?.params).toMatchObject({
      slug: 'safe-skill', confirmationToken: 'b'.repeat(32), archiveSha256: 'a'.repeat(64), confirmed: true,
    }))
  })
})

function marketSkill(slug: string, name: string, installed = false): MarketplaceSkill {
  return {
    id: `skillhub:${slug}`,
    slug,
    name,
    description: `${name} description`,
    pluginName: 'SkillHub',
    marketplace: 'SkillHub',
    publisher: 'Test Publisher',
    category: 'dev-programming',
    version: '1.0.0',
    installed,
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}
