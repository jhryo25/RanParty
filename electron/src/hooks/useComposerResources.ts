import { Dispatch, SetStateAction, useCallback, useEffect, useRef, useState } from 'react'
import type { ConnectorConfig, ExpertDefinition, ExpertTeamDefinition, Skill } from '../types'

interface ComposerResourceOptions {
  workspace: string
  setSelectedSkillIds: Dispatch<SetStateAction<string[]>>
  setSelectedExpertIds: Dispatch<SetStateAction<string[]>>
  setExpertTeamId: Dispatch<SetStateAction<string>>
  onNotice: (notice: string) => void
}

export interface ComposerResources {
  skills: Skill[]
  connectors: ConnectorConfig[]
  expertTeams: ExpertTeamDefinition[]
  experts: ExpertDefinition[]
  loadSkills: () => Promise<void>
  loadConnectors: () => Promise<void>
}

export function useComposerResources(options: ComposerResourceOptions): ComposerResources {
  const { workspace, setSelectedSkillIds, setSelectedExpertIds, setExpertTeamId, onNotice } = options
  const [skills, setSkills] = useState<Skill[]>([])
  const [connectors, setConnectors] = useState<ConnectorConfig[]>([])
  const [expertTeams, setExpertTeams] = useState<ExpertTeamDefinition[]>([])
  const [experts, setExperts] = useState<ExpertDefinition[]>([])
  const skillEpochRef = useRef(0)
  const connectorEpochRef = useRef(0)

  const loadSkills = useCallback(async () => {
    const epoch = ++skillEpochRef.current
    try {
      const result = await window.ranparty.request<{ skills: Skill[] }>('skills.list', { workspace })
      if (epoch !== skillEpochRef.current) return
      setSkills(result.skills)
      let availableExperts: ExpertDefinition[] = []
      try {
        const expertResult = await window.ranparty.request<{ experts: ExpertDefinition[]; teams: ExpertTeamDefinition[] }>('experts.list', {})
        availableExperts = expertResult.experts ?? []
        const availableTeams = expertResult.teams ?? []
        if (epoch === skillEpochRef.current) {
          setExpertTeams(availableTeams)
          setExperts(availableExperts)
          setExpertTeamId(current => current && !availableTeams.some(team => team.id === current) ? '' : current)
        }
      } catch {
        if (epoch === skillEpochRef.current) {
          setExpertTeams([])
          setExperts([])
          setExpertTeamId('')
        }
      }
      const visibleIds = new Set(result.skills.map((skill) => skill.id))
      setSelectedSkillIds((current) => current.filter((id) => visibleIds.has(id)))
      setSelectedExpertIds((current) => current.filter((id) => availableExperts.some((expert) => expert.id === id)))
    } catch (error) {
      if (epoch !== skillEpochRef.current) return
      onNotice(`Skill 列表读取失败：${messageOf(error)}`)
      setSkills([])
    }
  }, [onNotice, setExpertTeamId, setSelectedExpertIds, setSelectedSkillIds, workspace])

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

  return { skills, connectors, expertTeams, experts, loadSkills, loadConnectors }
}

function messageOf(reason: unknown) {
  return reason instanceof Error ? reason.message : String(reason)
}
