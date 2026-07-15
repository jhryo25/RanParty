import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { PetCompanion } from './PetCompanion'
import { PetSettings } from './PetSettings'
import type { PetState } from '../types'
import { installMockBridge } from '../mockBridge'

const state: PetState = {
  settings: { enabled: true, activePetId: 'test-pet', scale: 0.5, visionProfileName: '' },
  pets: [{ id: 'test-pet', displayName: 'Test Pet', description: '', spriteVersionNumber: 2, assetFormat: 'webp' }],
}

describe('PetCompanion', () => {
  beforeEach(() => {
    installMockBridge()
    Object.defineProperty(window, 'matchMedia', { configurable: true, value: vi.fn(() => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() })) })
  })

  it('maps waiting state to the Codex v2 waiting row', async () => {
    render(<PetCompanion state={state} turnState="waiting_approval" waitingForUser />)
    const pet = await screen.findByRole('button', { name: /Test Pet/ })
    await waitFor(() => expect(pet.style.backgroundPosition).toBe('0px -624px'))
    expect(pet.style.backgroundSize).toBe('768px 1144px')
  })

  it('refreshes an existing pet preview after reinstalling the same package id', async () => {
    let assetRequests = 0
    const originalRequest = window.ranparty.request
    window.ranparty.request = async <T,>(method: string, params?: Record<string, unknown>) => {
      if (method === 'pets.list' || method === 'pets.install') return state as T
      if (method === 'pets.asset') {
        assetRequests++
        return { id: String(params?.id), dataUrl: assetRequests === 1 ? 'data:image/webp;base64,T0xE' : 'data:image/webp;base64,TkVX' } as T
      }
      return originalRequest<T>(method, params)
    }
    window.ranparty.choosePetPackage = async () => 'D:\\pet\\pet.json'

    const view = render(<PetSettings />)
    await waitFor(() => expect(view.container.querySelector('.pet-package-preview span')).toHaveStyle({ backgroundImage: 'url(data:image/webp;base64,T0xE)' }))
    fireEvent.click(screen.getByRole('button', { name: '安装宠物包' }))
    await waitFor(() => expect(assetRequests).toBe(2))
    expect(view.container.querySelector('.pet-package-preview span')).toHaveStyle({ backgroundImage: 'url(data:image/webp;base64,TkVX)' })
  })
})
