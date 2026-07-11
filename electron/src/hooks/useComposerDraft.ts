import { Dispatch, SetStateAction, useCallback, useEffect, useRef, useState } from 'react'
import type { Attachment } from '../types'
import { emptyDraft, readDraft, StoredDraft, writeDraft } from '../components/composer-store'

export interface ComposerDraftState {
  text: string
  setText: Dispatch<SetStateAction<string>>
  attachments: Attachment[]
  setAttachments: Dispatch<SetStateAction<Attachment[]>>
  selectedSkillIds: string[]
  setSelectedSkillIds: Dispatch<SetStateAction<string[]>>
  selectedExpertIds: string[]
  setSelectedExpertIds: Dispatch<SetStateAction<string[]>>
  expertTeamId: string
  setExpertTeamId: Dispatch<SetStateAction<string>>
  clearCurrentDraft: () => void
}

export function useComposerDraft(sessionId: string): ComposerDraftState {
  const initialRef = useRef<StoredDraft | null>(null)
  if (initialRef.current === null) initialRef.current = readDraft(sessionId)
  const initial = initialRef.current
  const [text, setText] = useState(initial.text)
  const [attachments, setAttachments] = useState<Attachment[]>(initial.attachments)
  const [selectedSkillIds, setSelectedSkillIds] = useState<string[]>(initial.skillIds)
  const [selectedExpertIds, setSelectedExpertIds] = useState<string[]>(initial.expertIds)
  const [expertTeamId, setExpertTeamId] = useState(initial.expertTeamId ?? '')
  const draftRef = useRef<StoredDraft>(initial)
  draftRef.current = {
    text,
    attachments,
    skillIds: selectedSkillIds,
    expertIds: selectedExpertIds,
    expertTeamId,
    updatedAt: Date.now(),
  }

  useEffect(() => {
    writeDraft(sessionId, draftRef.current)
    return () => writeDraft(sessionId, draftRef.current)
  }, [attachments, expertTeamId, selectedExpertIds, selectedSkillIds, sessionId, text])

  const clearCurrentDraft = useCallback(() => {
    const empty = emptyDraft()
    draftRef.current = empty
    writeDraft(sessionId, empty)
    setText('')
    setAttachments([])
    setSelectedSkillIds([])
    setSelectedExpertIds([])
    setExpertTeamId('')
  }, [sessionId])

  return {
    text,
    setText,
    attachments,
    setAttachments,
    selectedSkillIds,
    setSelectedSkillIds,
    selectedExpertIds,
    setSelectedExpertIds,
    expertTeamId,
    setExpertTeamId,
    clearCurrentDraft,
  }
}
