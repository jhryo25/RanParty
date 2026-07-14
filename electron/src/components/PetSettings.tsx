import { Box, Check, LoaderCircle, Trash2, Upload } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import type { PetPackage, PetState } from '../types'

const EMPTY_STATE: PetState = { settings: { enabled: false, activePetId: '', scale: 0.62 }, pets: [] }

export function PetSettings() {
  const [state, setState] = useState<PetState>(EMPTY_STATE)
  const [assets, setAssets] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState('')

  const load = useCallback(async () => {
    const result = await window.ranparty.request<PetState>('pets.list')
    setState(result)
    return result
  }, [])

  useEffect(() => {
    let disposed = false
    void load().then(async result => {
      const nextAssets = await fetchPetAssets(result.pets)
      if (!disposed) setAssets(nextAssets)
    }).catch(reason => { if (!disposed) setNotice(messageOf(reason)) })
    return () => { disposed = true }
  }, [load])

  const active = useMemo(() => state.pets.find(pet => pet.id === state.settings.activePetId), [state])
  const configure = async (patch: { activePetId?: string; enabled?: boolean; scale?: number }) => {
    try { setState(await window.ranparty.request<PetState>('pets.configure', patch)); setNotice('已保存') }
    catch (reason) { setNotice(messageOf(reason)) }
  }
  const install = async () => {
    const manifestPath = await window.ranparty.choosePetPackage()
    if (!manifestPath) return
    setBusy(true); setNotice('')
    try {
      const next = await window.ranparty.request<PetState>('pets.install', { manifestPath })
      setState(next)
      setAssets(await fetchPetAssets(next.pets))
      setNotice('宠物包已安装并通过 Codex v2 校验')
    } catch (reason) { setNotice(messageOf(reason)) }
    finally { setBusy(false) }
  }
  const remove = async (pet: PetPackage) => {
    if (!window.confirm(`删除宠物“${pet.displayName}”？`)) return
    try {
      const next = await window.ranparty.request<PetState>('pets.delete', { id: pet.id })
      setState(next)
      setAssets(current => { const copy = { ...current }; delete copy[pet.id]; return copy })
      setNotice('已删除')
    } catch (reason) { setNotice(messageOf(reason)) }
  }

  return <section className="pet-settings">
    <div className="panel-title"><div><h3>桌面宠物</h3><p>直接兼容 Codex v2 宠物包。运行、等待批准、检查结果和失败时会切换对应动画。</p></div><button className="outline-button" disabled={busy} onClick={() => void install()}>{busy ? <LoaderCircle className="spin" size={15} /> : <Upload size={15} />}{busy ? '校验中' : '安装宠物包'}</button></div>
    <div className="pet-global-controls">
      <label><input type="checkbox" checked={state.settings.enabled} disabled={!active} onChange={event => void configure({ enabled: event.target.checked })} /><span><strong>显示桌面宠物</strong><small>{active ? `当前：${active.displayName}` : '安装并选择宠物后可启用'}</small></span></label>
      <label className="pet-scale"><span>显示比例</span><input type="range" min="0.4" max="1.25" step="0.05" value={state.settings.scale} onChange={event => void configure({ scale: Number(event.target.value) })} /><output>{Math.round(state.settings.scale * 100)}%</output></label>
    </div>
    {state.pets.length ? <div className="pet-package-list">{state.pets.map(pet => {
      const selected = pet.id === state.settings.activePetId
      return <article className={selected ? 'selected' : ''} key={pet.id}>
        <div className="pet-package-preview">{assets[pet.id] ? <span style={{ backgroundImage: `url(${assets[pet.id]})` }} /> : <Box size={28} />}</div>
        <div><strong>{pet.displayName}</strong><p>{pet.description || 'Codex v2 动态宠物'}</p><small>{pet.id} · {pet.assetFormat.toUpperCase()} · v2</small></div>
        <button className="outline-button" disabled={selected} onClick={() => void configure({ activePetId: pet.id, enabled: true })}>{selected ? <Check size={14} /> : null}{selected ? '已选择' : '选择'}</button>
        <button className="icon-button danger" title="删除宠物" aria-label={`删除 ${pet.displayName}`} onClick={() => void remove(pet)}><Trash2 size={15} /></button>
      </article>
    })}</div> : <div className="pet-empty"><Box size={30} /><strong>还没有安装宠物</strong><p>选择 Codex v2 包里的 pet.json。图集必须是 1536×2288 的 PNG 或 WebP。</p></div>}
    {notice ? <div className="pet-notice" role="status">{notice}</div> : null}
  </section>
}

function messageOf(reason: unknown) { return reason instanceof Error ? reason.message : String(reason) }

async function fetchPetAssets(pets: PetPackage[]) {
  const entries = await Promise.all(pets.map(async pet => {
    try {
      const asset = await window.ranparty.request<{ id: string; dataUrl: string }>('pets.asset', { id: pet.id })
      return [asset.id, asset.dataUrl] as const
    } catch { return null }
  }))
  return Object.fromEntries(entries.filter((entry): entry is readonly [string, string] => entry !== null))
}
