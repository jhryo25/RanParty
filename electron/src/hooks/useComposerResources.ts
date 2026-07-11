import { Dispatch, SetStateAction, useCallback, useEffect, useRef, useState } from 'react'
import type { ConnectorConfig, ExpertTeamDefinition, Skill } from '../types'

interface ComposerResourceOptions {
  workspace: string
  setSelectedSkillIds: Dispatch<SetStateAction<string[]>>
  setSelectedExpertIds: Dispatch<SetStateAction<string[]>>
  onNotice: (notice: string) => void
}

export interface ComposerResources {
  skills: Skill[]
  connectors: ConnectorConfig[]
  expertTeams: ExpertTeamDefinition[]
  loadSkills: () => Promise<void>
  loadConnectors: () => Promise<void>
}

export function useComposerResources(options: ComposerResourceOptions): ComposerResources {
  const { workspace, setSelectedSkillIds, setSelectedExpertIds, onNotice } = options
  const [skills, setSkills] = useState<Skill[]>([])
  const [connectors, setConnectors] = useState<ConnectorConfig[]>([])
  const [expertTeams, setExpertTeams] = useState<ExpertTeamDefinition[]>([])
  const skillEpochRef = useRef(0)
  const connectorEpochRef = useRef(0)

  const loadSkills = useCallback(async () => {
    const epoch = ++skillEpochRef.current
    try {
      const result = await window.ranparty.request<{ skills: Skill[] }>('skills.list', { workspace })
      if (epoch !== skillEpochRef.current) return
      setSkills(result.skills)
      try {
        const experts = await window.ranparty.request<{ teams: ExpertTeamDefinition[] }>('experts.list', {})
        if (epoch === skillEpochRef.current) setExpertTeams(experts.teams ?? [])
      } catch { if (epoch === skillEpochRef.current) setExpertTeams([]) }
      const visibleIds = new Set(result.skills.map((skill) => skill.id))
      setSelectedSkillIds((current) => current.filter((id) => visibleIds.has(id)))
      setSelectedExpertIds((current) => current.filter((id) => visibleIds.has(id)))
    } catch (error) {
      if (epoch !== skillEpochRef.current) return
      onNotice(`Skill 列表读取失败：${messageOf(error)}`)
      setSkills([])
    }
  }, [onNotice, setSelectedExpertIds, setSelectedSkillIds, workspace])

  const loadConnectors = useCallback(async () => {
    const epoch = ++connectorEpochRef.current
    try {
      const result = await window.ranparty.request<{ connectors: ConnectorConfig[] }>('connectors.list', {})
      if (epoch === connectorEpochRef.current) setConnectors(result.connectors)
    } catch {
      if (epoch === connectorEpochRef.current) setConnectors([])
    }
  }, [])

  useEffect(() => {
    void loadSkills()
    void loadConnectors()
    return () => {
      skillEpochRef.current++
      connectorEpochRef.current++
    }
  }, [loadConnectors, loadSkills])

  useEffect(() => {
    const refresh = () => void loadSkills()
    window.addEventListener('ranparty:skills-changed', refresh)
    return () => window.removeEventListener('ranparty:skills-changed', refresh)
  }, [loadSkills])

  return { skills, connectors, expertTeams, loadSkills, loadConnectors }
}

function messageOf(reason: unknown) {
  return reason instanceof Error ? reason.message : String(reason)
}
