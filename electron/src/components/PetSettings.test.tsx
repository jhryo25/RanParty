import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { installMockBridge } from '../mockBridge'
import type { PetState, Profile } from '../types'
import { PetSettings } from './PetSettings'

const visionProfile: Profile = {
  name: 'Vision Helper',
  baseUrl: 'https://example.test/v1',
  model: 'vision-model',
  characterCard: '',
  characterDisplayName: 'Vision Helper',
  provider: 'openai',
  wireProtocol: 'responses',
  supportsTools: false,
  supportsImages: true,
  supportsReasoning: false,
  supportsWebSearch: false,
  contextWindow: 128000,
  maxOutputTokens: 8192,
  apiKeyConfigured: true,
}

const textProfile: Profile = {
  ...visionProfile,
  name: 'Text Only',
  model: 'text-model',
  supportsImages: false,
}

describe('PetSettings vision profile', () => {
  beforeEach(() => installMockBridge())

  it('explains where to upload a reference image and opens the task flow', async () => {
    const onStartCreation = vi.fn()
    const { request } = installPetRequests()
    render(<PetSettings profiles={[visionProfile]} onStartCreation={onStartCreation} />)

    await waitFor(() => expect(request).toHaveBeenCalledWith('pets.list'))
    expect(screen.getByRole('heading', { name: '用参考图制作新宠物' })).toBeInTheDocument()
    expect(screen.getByText(/参考图不在“安装成品宠物包”里选择/)).toBeInTheDocument()
    expect(screen.getByText(/\+ → 技能/)).toBeInTheDocument()
    expect(screen.getByText('hatch-pet')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '安装成品宠物包' })).toHaveAttribute('title', '选择生成后的 pet.json')

    fireEvent.click(screen.getByRole('button', { name: /去任务里上传参考图/ }))
    expect(onStartCreation).toHaveBeenCalledOnce()
  })

  it('lists image-capable profiles and persists the selected profile', async () => {
    const { request } = installPetRequests()
    render(<PetSettings profiles={[textProfile, visionProfile]} />)

    await waitFor(() => expect(request).toHaveBeenCalledWith('pets.list'))
    const select = screen.getByRole('combobox', { name: /识图模型/ })
    expect(within(select).getByRole('option', { name: /Vision Helper · vision-model/ })).toBeInTheDocument()
    expect(within(select).queryByRole('option', { name: /Text Only/ })).not.toBeInTheDocument()

    fireEvent.change(select, { target: { value: visionProfile.name } })

    await waitFor(() => expect(request).toHaveBeenCalledWith('pets.configure', { visionProfileName: visionProfile.name }))
    await waitFor(() => expect(select).toHaveValue(visionProfile.name))
  })

  it('disables the selector and offers model configuration when no vision profile exists', async () => {
    const onManageModels = vi.fn()
    const { request } = installPetRequests()
    render(<PetSettings profiles={[textProfile]} onManageModels={onManageModels} />)

    await waitFor(() => expect(request).toHaveBeenCalledWith('pets.list'))
    expect(screen.getByRole('combobox', { name: /识图模型/ })).toBeDisabled()

    fireEvent.click(screen.getByRole('button', { name: /模型/ }))
    expect(onManageModels).toHaveBeenCalledOnce()
  })

  it('shows the backend error when saving the vision profile fails', async () => {
    const { request } = installPetRequests({ configureError: '保存识图模型失败' })
    render(<PetSettings profiles={[visionProfile]} />)

    await waitFor(() => expect(request).toHaveBeenCalledWith('pets.list'))
    const select = screen.getByRole('combobox', { name: /识图模型/ })
    fireEvent.change(select, { target: { value: visionProfile.name } })

    expect(await screen.findByRole('alert')).toHaveTextContent('保存识图模型失败')
    expect(request).toHaveBeenCalledWith('pets.configure', { visionProfileName: visionProfile.name })
  })
})

function installPetRequests({ configureError = '' }: { configureError?: string } = {}) {
  let state: PetState = {
    settings: { enabled: false, activePetId: '', scale: 0.62, visionProfileName: '' },
    pets: [],
  }
  const request = vi.fn(async (method: string, params: Record<string, unknown> = {}) => {
    if (method === 'pets.list') return state
    if (method === 'pets.configure') {
      if (configureError) throw new Error(configureError)
      state = {
        ...state,
        settings: {
          ...state.settings,
          visionProfileName: typeof params.visionProfileName === 'string'
            ? params.visionProfileName
            : state.settings.visionProfileName,
        },
      }
      return state
    }
    throw new Error(`Unexpected request: ${method}`)
  })
  window.ranparty.request = request as typeof window.ranparty.request
  return { request }
}
