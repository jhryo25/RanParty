import { ArrowRight, Box, Check, Eye, ImagePlus, LoaderCircle, Settings2, Trash2, Upload, WandSparkles } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { PetPackage, PetState, Profile } from '../types'

const EMPTY_STATE: PetState = { settings: { enabled: false, activePetId: '', scale: 0.62, visionProfileName: '' }, pets: [] }

interface Props {
  profiles?: Profile[]
  onManageModels?: () => void
  onStartCreation?: () => void
}

type SaveKind = 'enabled' | 'scale' | 'vision' | 'pet'
type Notice = { tone: 'success' | 'error'; text: string }

export function PetSettings({ profiles = [], onManageModels, onStartCreation }: Props) {
  const [state, setState] = useState<PetState>(EMPTY_STATE)
  const [scaleDraft, setScaleDraft] = useState(EMPTY_STATE.settings.scale)
  const [assets, setAssets] = useState<Record<string, string>>({})
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [saving, setSaving] = useState<SaveKind | null>(null)
  const [notice, setNotice] = useState<Notice | null>(null)
  const savingRef = useRef(false)

  const visionProfiles = useMemo(() => profiles.filter(profile => profile.supportsImages), [profiles])
  const active = useMemo(() => state.pets.find(pet => pet.id === state.settings.activePetId), [state])
  const staleVisionProfile = state.settings.visionProfileName
    && !visionProfiles.some(profile => profile.name === state.settings.visionProfileName)

  const refresh = useCallback(async () => {
    const result = await window.ranparty.request<PetState>('pets.list')
    setState(result)
    setScaleDraft(result.settings.scale)
    return result
  }, [])

  useEffect(() => {
    let disposed = false
    setLoading(true)
    void refresh().then(async result => {
      const nextAssets = await fetchPetAssets(result.pets)
      if (!disposed) setAssets(nextAssets)
    }).catch(reason => {
      if (!disposed) setNotice({ tone: 'error', text: `宠物设置加载失败：${messageOf(reason)}` })
    }).finally(() => {
      if (!disposed) setLoading(false)
    })
    return () => { disposed = true }
  }, [refresh])

  const configure = async (patch: { activePetId?: string; enabled?: boolean; scale?: number; visionProfileName?: string }, kind: SaveKind, success: string) => {
    if (savingRef.current) return
    savingRef.current = true
    setSaving(kind)
    setNotice(null)
    try {
      const next = await window.ranparty.request<PetState>('pets.configure', patch)
      setState(next)
      setScaleDraft(next.settings.scale)
      setNotice({ tone: 'success', text: success })
    } catch (reason) {
      setNotice({ tone: 'error', text: `保存失败：${messageOf(reason)}` })
      try { await refresh() } catch { /* Keep the original actionable error. */ }
    } finally {
      savingRef.current = false
      setSaving(null)
    }
  }

  const commitScale = (value: number) => {
    if (value === state.settings.scale || savingRef.current) return
    void configure({ scale: value }, 'scale', '显示比例已保存')
  }

  const install = async () => {
    const manifestPath = await window.ranparty.choosePetPackage()
    if (!manifestPath) return
    setBusy(true)
    setNotice(null)
    try {
      const next = await window.ranparty.request<PetState>('pets.install', { manifestPath })
      setState(next)
      setScaleDraft(next.settings.scale)
      setAssets(await fetchPetAssets(next.pets))
      setNotice({ tone: 'success', text: '宠物包已安装并通过 Codex v2 校验' })
    } catch (reason) {
      setNotice({ tone: 'error', text: `安装失败：${messageOf(reason)}` })
    } finally { setBusy(false) }
  }

  const remove = async (pet: PetPackage) => {
    if (!window.confirm(`删除宠物“${pet.displayName}”？`)) return
    setBusy(true)
    setNotice(null)
    try {
      const next = await window.ranparty.request<PetState>('pets.delete', { id: pet.id })
      setState(next)
      setScaleDraft(next.settings.scale)
      setAssets(current => { const copy = { ...current }; delete copy[pet.id]; return copy })
      setNotice({ tone: 'success', text: '宠物已删除' })
    } catch (reason) {
      setNotice({ tone: 'error', text: `删除失败：${messageOf(reason)}` })
    } finally { setBusy(false) }
  }

  const controlsDisabled = loading || busy || saving !== null
  const noVisionProfiles = visionProfiles.length === 0

  return <section className="pet-settings">
    <div className="panel-title"><div><h3>桌面宠物</h3><p>在任务中用参考图制作宠物，再在这里安装和管理生成后的 Codex v2 成品包。</p></div><button className="outline-button" title="选择生成后的 pet.json" disabled={busy} onClick={() => void install()}>{busy ? <LoaderCircle className="spin" size={15} /> : <Upload size={15} />}{busy ? '处理中…' : '安装成品宠物包'}</button></div>

    <section className="pet-creation-guide" aria-labelledby="pet-creation-guide-title">
      <div className="pet-creation-guide-head">
        <span className="pet-creation-guide-icon"><WandSparkles size={20} /></span>
        <div><h4 id="pet-creation-guide-title">用参考图制作新宠物</h4><p>参考图不在“安装成品宠物包”里选择。制作发生在任务输入区，这里只负责安装生成后的 <code>pet.json</code>。</p></div>
        {onStartCreation ? <button type="button" className="primary-button" onClick={onStartCreation}><ImagePlus size={15} />去任务里上传参考图<ArrowRight size={14} /></button> : null}
      </div>
      <ol className="pet-creation-steps">
        <li><span>1</span><div><strong>选择识图模型</strong><small>在下方选择一个支持图片输入的模型。</small></div></li>
        <li><span>2</span><div><strong>上传参考图</strong><small>回到任务输入框，点“+ → 添加文件”，也可直接粘贴或拖入。</small></div></li>
        <li><span>3</span><div><strong>启用制作技能</strong><small>再点“+ → 技能”，选择 <code>hatch-pet</code> 后发送制作要求。</small></div></li>
        <li><span>4</span><div><strong>安装生成结果</strong><small>完成后回到本页，安装生成目录里的 <code>pet.json</code>。</small></div></li>
      </ol>
    </section>

    <div className="pet-global-controls">
      <div className="pet-control-card pet-enabled-control">
        <label className="pet-toggle"><input type="checkbox" checked={state.settings.enabled} disabled={controlsDisabled || !active} onChange={event => void configure({ enabled: event.target.checked }, 'enabled', event.target.checked ? '桌面宠物已显示' : '桌面宠物已隐藏')} /><span><strong>显示桌面宠物</strong><small>{active ? `当前：${active.displayName}` : '安装并选择宠物后可启用'}</small></span></label>
        {saving === 'enabled' ? <LoaderCircle className="spin pet-saving" size={15} aria-label="正在保存显示设置" /> : null}
      </div>

      <div className="pet-control-card pet-scale-control">
        <div className="pet-control-heading"><span><strong>显示比例</strong><small>拖动时即时预览，松开后保存</small></span><output htmlFor="pet-scale-slider">{Math.round(scaleDraft * 100)}%</output></div>
        <input id="pet-scale-slider" aria-label="桌面宠物显示比例" type="range" min="0.4" max="1.25" step="0.05" value={scaleDraft} disabled={controlsDisabled} onChange={event => setScaleDraft(Number(event.target.value))} onPointerUp={event => commitScale(Number(event.currentTarget.value))} onKeyUp={event => commitScale(Number(event.currentTarget.value))} onBlur={event => commitScale(Number(event.currentTarget.value))} />
      </div>

      <div className="pet-control-card pet-vision">
        <div className="pet-control-heading"><Eye size={17} /><span><strong>识图模型</strong><small>用于分析宠物参考图，并生成更准确的制作提示</small></span></div>
        <div className="pet-vision-picker">
          <select aria-label="识图模型" value={state.settings.visionProfileName} disabled={controlsDisabled || (noVisionProfiles && !staleVisionProfile)} onChange={event => void configure({ visionProfileName: event.target.value }, 'vision', event.target.value ? '识图模型已保存' : '已关闭参考图识别')}>
            {staleVisionProfile ? <option value={state.settings.visionProfileName}>已失效：{state.settings.visionProfileName}</option> : null}
            <option value="">{noVisionProfiles ? '暂无支持图片输入的模型' : '暂不使用识图模型'}</option>
            {visionProfiles.map(profile => <option key={profile.name} value={profile.name}>{profile.name} · {profile.model}</option>)}
          </select>
          {onManageModels ? <button type="button" className="outline-button pet-manage-models" disabled={controlsDisabled} onClick={onManageModels}><Settings2 size={14} />{noVisionProfiles ? '配置图片模型' : '管理模型'}</button> : null}
          {saving === 'vision' ? <LoaderCircle className="spin pet-saving" size={15} aria-label="正在保存识图模型" /> : null}
        </div>
      </div>
    </div>

    {loading ? <div className="pet-empty pet-loading" role="status"><LoaderCircle className="spin" size={28} /><strong>正在加载宠物设置…</strong></div> : state.pets.length ? <div className="pet-package-list">{state.pets.map(pet => {
      const selected = pet.id === state.settings.activePetId
      return <article className={selected ? 'selected' : ''} key={pet.id}>
        <div className="pet-package-preview">{assets[pet.id] ? <span style={{ backgroundImage: `url(${assets[pet.id]})` }} /> : <Box size={28} />}</div>
        <div><strong>{pet.displayName}</strong><p>{pet.description || 'Codex v2 动态宠物'}</p><small>{pet.id} · {pet.assetFormat.toUpperCase()} · v2</small></div>
        <button className="outline-button" disabled={controlsDisabled || selected} onClick={() => void configure({ activePetId: pet.id, enabled: true }, 'pet', '已切换桌面宠物')}>{selected ? <Check size={14} /> : null}{selected ? '已选择' : saving === 'pet' ? '切换中…' : '选择'}</button>
        <button className="icon-button danger" disabled={busy} title="删除宠物" aria-label={`删除 ${pet.displayName}`} onClick={() => void remove(pet)}><Trash2 size={15} /></button>
      </article>
    })}</div> : <div className="pet-empty"><Box size={30} /><strong>还没有安装成品宠物</strong><p>先按上方步骤从参考图制作，再选择 Codex v2 包里的 pet.json。图集必须是 1536×2288 的 PNG 或 WebP。</p></div>}
    {notice ? <div className={`pet-notice ${notice.tone}`} role={notice.tone === 'error' ? 'alert' : 'status'}>{notice.text}</div> : null}
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
