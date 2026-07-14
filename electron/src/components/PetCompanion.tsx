import { useEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from 'react'
import type { PetState, Session } from '../types'

interface Props {
  state: PetState
  turnState?: Session['turnState']
  waitingForUser: boolean
}

type PetAnimation = 'idle' | 'running-right' | 'running-left' | 'waving' | 'jumping' | 'failed' | 'waiting' | 'running' | 'review'

const ANIMATIONS: Record<PetAnimation, { row: number; durations: number[] }> = {
  idle: { row: 0, durations: [280, 110, 110, 140, 140, 320] },
  'running-right': { row: 1, durations: [120, 120, 120, 120, 120, 120, 120, 220] },
  'running-left': { row: 2, durations: [120, 120, 120, 120, 120, 120, 120, 220] },
  waving: { row: 3, durations: [140, 140, 140, 280] },
  jumping: { row: 4, durations: [140, 140, 140, 140, 280] },
  failed: { row: 5, durations: [140, 140, 140, 140, 140, 140, 140, 240] },
  waiting: { row: 6, durations: [150, 150, 150, 150, 150, 260] },
  running: { row: 7, durations: [120, 120, 120, 120, 120, 220] },
  review: { row: 8, durations: [150, 150, 150, 150, 150, 280] },
}

export function PetCompanion({ state, turnState, waitingForUser }: Props) {
  const activePet = useMemo(() => state.pets.find(pet => pet.id === state.settings.activePetId), [state])
  const [asset, setAsset] = useState('')
  const [frame, setFrame] = useState(0)
  const [reaction, setReaction] = useState<PetAnimation | null>('waving')
  const [reviewing, setReviewing] = useState(false)
  const [lookCell, setLookCell] = useState<{ row: number; column: number } | null>(null)
  const [drag, setDrag] = useState<{ pointerId: number; startX: number; startY: number; originX: number; originY: number; direction: 'left' | 'right' } | null>(null)
  const [offset, setOffset] = useState(readPosition)
  const petRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    let disposed = false
    setAsset('')
    if (!activePet || !state.settings.enabled) return () => { disposed = true }
    void window.ranparty.request<{ dataUrl: string }>('pets.asset', { id: activePet.id })
      .then(result => { if (!disposed) setAsset(result.dataUrl) })
      .catch(() => { if (!disposed) setAsset('') })
    return () => { disposed = true }
  }, [activePet, state.settings.enabled])

  useEffect(() => {
    if (turnState !== 'completed') return () => {}
    setReviewing(true)
    const timer = window.setTimeout(() => setReviewing(false), 2600)
    return () => window.clearTimeout(timer)
  }, [turnState])

  useEffect(() => {
    if (!reaction) return () => {}
    const total = ANIMATIONS[reaction].durations.reduce((sum, duration) => sum + duration, 0)
    const timer = window.setTimeout(() => setReaction(null), total)
    return () => window.clearTimeout(timer)
  }, [reaction])

  const animation: PetAnimation = drag
    ? drag.direction === 'left' ? 'running-left' : 'running-right'
    : turnState === 'failed' ? 'failed'
      : waitingForUser ? 'waiting'
        : turnState === 'running' || turnState === 'retrying' || turnState === 'cancelling' ? 'running'
          : reaction ?? (reviewing ? 'review' : 'idle')

  useEffect(() => {
    setFrame(0)
    if (typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return () => {}
    const durations = ANIMATIONS[animation].durations
    let timer = 0
    const advance = (current: number) => {
      timer = window.setTimeout(() => {
        const next = (current + 1) % durations.length
        setFrame(next)
        advance(next)
      }, durations[current])
    }
    advance(0)
    return () => window.clearTimeout(timer)
  }, [animation])

  useEffect(() => {
    const track = (event: PointerEvent) => {
      if (animation !== 'idle' || !petRef.current) { setLookCell(null); return }
      const rect = petRef.current.getBoundingClientRect()
      const dx = event.clientX - (rect.left + rect.width / 2)
      const dy = event.clientY - (rect.top + rect.height / 2)
      const distance = Math.hypot(dx, dy)
      if (distance < 55 || distance > 380) { setLookCell(null); return }
      const degrees = (Math.atan2(dx, -dy) * 180 / Math.PI + 360) % 360
      const index = Math.round(degrees / 22.5) % 16
      setLookCell({ row: 9 + Math.floor(index / 8), column: index % 8 })
    }
    window.addEventListener('pointermove', track)
    return () => window.removeEventListener('pointermove', track)
  }, [animation])

  const startDrag = (event: ReactPointerEvent<HTMLButtonElement>) => {
    event.currentTarget.setPointerCapture(event.pointerId)
    setDrag({ pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, originX: offset.x, originY: offset.y, direction: 'right' })
  }
  const moveDrag = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (!drag || event.pointerId !== drag.pointerId) return
    const deltaX = event.clientX - drag.startX
    const deltaY = event.clientY - drag.startY
    setDrag(current => current ? { ...current, direction: deltaX < 0 ? 'left' : 'right' } : current)
    setOffset({ x: clamp(drag.originX + deltaX, -window.innerWidth + 150, 0), y: clamp(drag.originY + deltaY, -window.innerHeight + 190, 0) })
  }
  const endDrag = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (!drag || event.pointerId !== drag.pointerId) return
    const moved = Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) > 5
    setDrag(null)
    localStorage.setItem('ranparty.pet-position', JSON.stringify(offset))
    if (!moved) setReaction('waving')
  }

  if (!state.settings.enabled || !activePet || !asset) return null
  const cell = lookCell ?? { row: ANIMATIONS[animation].row, column: frame }
  const scale = state.settings.scale
  const style = {
    width: `${192 * scale}px`, height: `${208 * scale}px`,
    backgroundImage: `url(${asset})`,
    backgroundSize: `${1536 * scale}px ${2288 * scale}px`,
    backgroundPosition: `${-cell.column * 192 * scale}px ${-cell.row * 208 * scale}px`,
    transform: `translate(${offset.x}px, ${offset.y}px)`,
  } satisfies CSSProperties

  return <button ref={petRef} type="button" className={`pet-companion ${drag ? 'dragging' : ''}`} style={style} aria-label={`${activePet.displayName}，可拖动`} title={activePet.displayName} onPointerDown={startDrag} onPointerMove={moveDrag} onPointerUp={endDrag} onPointerCancel={endDrag} onDoubleClick={() => setReaction('jumping')} />
}

function readPosition() {
  try {
    const value: unknown = JSON.parse(localStorage.getItem('ranparty.pet-position') || '{}')
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const x = Reflect.get(value, 'x'); const y = Reflect.get(value, 'y')
      if (typeof x === 'number' && typeof y === 'number') return { x, y }
    }
  } catch { /* Invalid local position falls back to the corner. */ }
  return { x: 0, y: 0 }
}

function clamp(value: number, minimum: number, maximum: number) { return Math.min(maximum, Math.max(minimum, value)) }
