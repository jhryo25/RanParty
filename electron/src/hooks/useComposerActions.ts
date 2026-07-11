import {
  ClipboardEvent,
  Dispatch,
  DragEvent,
  KeyboardEvent,
  RefObject,
  SetStateAction,
  useCallback,
  useRef,
  useState,
} from 'react'
import type { Attachment, Profile, SendEnvelope, Session, SessionMode } from '../types'
import { dataUrlBytes, MAX_IMAGE_BYTES, MAX_IMAGES } from '../components/composer-store'
import { extractSessionReferenceIds, filesToAttachments, messageOf, stripSessionReferences } from '../components/composer-utils'

interface ComposerActionOptions {
  busy: boolean
  session: Session
  activeProfile?: Profile
  canAttachImages: boolean
  text: string
  setText: Dispatch<SetStateAction<string>>
  attachments: Attachment[]
  setAttachments: Dispatch<SetStateAction<Attachment[]>>
  selectedSkillIds: string[]
  selectedExpertIds: string[]
  expertTeamId: string
  selectedReferenceIds: string[]
  inputRef: RefObject<HTMLTextAreaElement | null>
  clearCurrentDraft: () => void
  enqueue: (envelope: SendEnvelope) => void
  onSend: (envelope: SendEnvelope) => Promise<void>
  onUpdate: (patch: Record<string, unknown>) => Promise<void>
  onChooseImages: () => Promise<Attachment[]>
  onAddSessionReference: (referenceId: string) => Promise<void>
  onNotice: (notice: string) => void
  onCloseMenus: () => void
}

export interface ComposerActions {
  sending: boolean
  chooseImages: () => Promise<void>
  send: () => Promise<void>
  onKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => void
  onPaste: (event: ClipboardEvent<HTMLTextAreaElement>) => Promise<void>
  onDrop: (event: DragEvent<HTMLDivElement>) => Promise<void>
}

export function useComposerActions(options: ComposerActionOptions): ComposerActions {
  const {
    busy, session, activeProfile, canAttachImages, text, setText, attachments, setAttachments,
    selectedSkillIds, selectedExpertIds, expertTeamId, selectedReferenceIds, inputRef, clearCurrentDraft,
    enqueue, onSend, onUpdate, onChooseImages, onAddSessionReference, onNotice, onCloseMenus,
  } = options
  const [sending, setSending] = useState(false)
  const sendLockRef = useRef(false)

  const addAttachments = useCallback((items: Attachment[]) => {
    if (!canAttachImages) {
      onNotice('未配置支持图片输入的模型，无法识别图片。请先在模型配置中启用一个多模态模型。')
      return
    }
    if (!activeProfile?.supportsImages) {
      onNotice('当前模型不支持图片，图片将自动交给支持多模态的子 Agent 识别。')
    }
    const valid = items.filter((item) => {
      if (!item.dataUrl.startsWith('data:image/')) return false
      if ((item.size ?? dataUrlBytes(item.dataUrl)) > MAX_IMAGE_BYTES) {
        onNotice(`${item.name} 超过 10MB，未添加。`)
        return false
      }
      return true
    })
    setAttachments((current) => {
      const room = MAX_IMAGES - current.length
      if (valid.length > room) onNotice(`最多附加 ${MAX_IMAGES} 张图片。`)
      return [...current, ...valid.slice(0, Math.max(0, room))]
    })
  }, [activeProfile?.supportsImages, canAttachImages, onNotice, setAttachments])

  const chooseImages = useCallback(async () => {
    try { addAttachments(await onChooseImages()) }
    catch (error) { onNotice(`图片读取失败：${messageOf(error)}`) }
  }, [addAttachments, onChooseImages, onNotice])

  const send = useCallback(async () => {
    if (sendLockRef.current || sending) return
    let value = text.trim()
    if (!session.workspace || (!value && attachments.length === 0)) return
    sendLockRef.current = true
    const envelope: SendEnvelope = {
      clientMessageId: `send_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      sessionId: session.id,
      text: value,
      imageDataUrls: attachments.map((item) => item.dataUrl),
      skillIds: [...selectedSkillIds],
      expertIds: [...selectedExpertIds],
      expertTeamId: expertTeamId || undefined,
      referencedSessionIds: [...selectedReferenceIds],
    }

    try {
      if (busy) {
        enqueue(envelope)
        clearCurrentDraft()
        onNotice('已加入队列，等待发送')
        inputRef.current?.focus()
        await Promise.resolve()
        return
      }

      const slashMatch = value.match(/^\/(plan|ask|default|goal)\b\s*(.*)/i)
      if (slashMatch) {
        const [, command, rest] = slashMatch
        const mode = sessionMode(command)
        if (!mode) return
        if (mode === 'goal') {
          const goalText = rest || window.prompt('Goal mode target?')?.trim()
          if (!goalText) return
          try { await onUpdate({ mode, goal: { text: goalText, status: 'active' } }) }
          catch (error) { onNotice(`模式切换失败：${messageOf(error)}`); return }
          value = goalText
        } else {
          try { await onUpdate({ mode }) }
          catch (error) { onNotice(`模式切换失败：${messageOf(error)}`); return }
          value = rest || ''
        }
        if (!value && attachments.length === 0) {
          setText('')
          inputRef.current?.focus()
          return
        }
      }

      setSending(true)
      try {
        await onSend({ ...envelope, text: value })
        clearCurrentDraft()
        onCloseMenus()
        onNotice('')
        inputRef.current?.focus()
      } catch (error) {
        onNotice(`发送失败，内容已保留：${messageOf(error)}`)
      }
    } finally {
      setSending(false)
      sendLockRef.current = false
    }
  }, [attachments, busy, clearCurrentDraft, enqueue, inputRef, onCloseMenus, onNotice, onSend, onUpdate,
    selectedExpertIds, selectedReferenceIds, selectedSkillIds, sending, session.id, session.workspace, setText, text])

  const onKeyDown = useCallback((event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== 'Enter' || event.shiftKey) return
    event.preventDefault()
    void send()
  }, [send])

  const onPaste = useCallback(async (event: ClipboardEvent<HTMLTextAreaElement>) => {
    const plain = event.clipboardData.getData('text')
    const references = extractSessionReferenceIds(plain)
    if (references.length > 0) {
      event.preventDefault()
      for (const id of references) await onAddSessionReference(id)
      const cleaned = stripSessionReferences(plain, references)
      if (cleaned) setText((current) => current ? `${current}\n${cleaned}` : cleaned)
      return
    }
    const files = [...event.clipboardData.files].filter((file) => file.type.startsWith('image/'))
    if (!files.length) return
    event.preventDefault()
    try { addAttachments(await filesToAttachments(files)) }
    catch (error) { onNotice(`粘贴图片失败：${messageOf(error)}`) }
  }, [addAttachments, onAddSessionReference, onNotice, setText])

  const onDrop = useCallback(async (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault()
    const files = [...event.dataTransfer.files].filter((file) => file.type.startsWith('image/'))
    if (!files.length) return
    try { addAttachments(await filesToAttachments(files)) }
    catch (error) { onNotice(`拖入图片失败：${messageOf(error)}`) }
  }, [addAttachments, onNotice])

  return { sending, chooseImages, send, onKeyDown, onPaste, onDrop }
}

function sessionMode(value: string): SessionMode | null {
  const normalized = value.toLocaleLowerCase()
  if (normalized === 'default' || normalized === 'plan' || normalized === 'ask' || normalized === 'goal') return normalized
  return null
}
