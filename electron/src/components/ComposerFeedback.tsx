import { Sparkles, X } from 'lucide-react'
import type { Attachment, ExpertTeamDefinition, Session, SessionReference, Skill } from '../types'
import type { QueuedSend } from './composer-store'

interface ComposerSelectionsProps {
  attachments: Attachment[]
  references: SessionReference[]
  experts: Skill[]
  skills: Skill[]
  expertTeam?: ExpertTeamDefinition
  onRemoveAttachment: (index: number) => void
  onRemoveReference: (id: string) => void
  onRemoveExpert: (id: string) => void
  onRemoveSkill: (id: string) => void
  onRemoveExpertTeam: () => void
}

export function ComposerSelections(props: ComposerSelectionsProps) {
  const { attachments, references, experts, skills, expertTeam, onRemoveAttachment, onRemoveReference, onRemoveExpert, onRemoveSkill, onRemoveExpertTeam } = props
  if (!attachments.length && !references.length && !experts.length && !skills.length && !expertTeam) return null
  return <div className="composer-attachments">
    {attachments.map((attachment, index) => (
      <div className="image-preview" key={`${attachment.name}-${index}`}>
        <img src={attachment.dataUrl} alt={attachment.name} />
        <button onClick={() => onRemoveAttachment(index)} aria-label={`移除 ${attachment.name}`}><X size={13} /></button>
      </div>
    ))}
    {references.map((reference) => <Chip key={reference.id} label={`引用会话：${reference.title}`} onRemove={() => onRemoveReference(reference.id)} />)}
    {experts.map((skill) => <Chip key={skill.id} label={`专家：${skill.name}`} onRemove={() => onRemoveExpert(skill.id)} />)}
    {expertTeam ? <Chip label={`专家团：${expertTeam.name}`} onRemove={onRemoveExpertTeam} /> : null}
    {skills.map((skill) => <Chip key={skill.id} label={`技能：${skill.name}`} onRemove={() => onRemoveSkill(skill.id)} />)}
  </div>
}

interface ComposerQueueProps {
  queue: QueuedSend[]
  sessions: Session[]
  onRetry: (clientMessageId: string) => void
  onRemove: (clientMessageId: string) => void
}

export function ComposerQueue({ queue, sessions, onRetry, onRemove }: ComposerQueueProps) {
  if (!queue.length) return null
  return <div className="composer-queue" aria-live="polite">
    {queue.map((item) => {
      const target = sessions.find((candidate) => candidate.id === item.sessionId)
      return <div className={`queue-row ${item.status}`} key={item.clientMessageId}>
        <span><strong>{target?.title || item.sessionId}</strong><small>{item.text || `${item.imageDataUrls.length} 张图片`}</small></span>
        <em>{item.status === 'sending' ? '发送中' : item.status === 'failed' ? '发送失败' : '等待发送'}</em>
        {item.status === 'failed' ? <button type="button" onClick={() => onRetry(item.clientMessageId)}>重试</button> : null}
        <button type="button" aria-label={`移除发往 ${target?.title || item.sessionId} 的队列消息`} onClick={() => onRemove(item.clientMessageId)}><X size={12} /></button>
      </div>
    })}
  </div>
}

interface ChipProps {
  label: string
  onRemove: () => void
}

function Chip({ label, onRemove }: ChipProps) {
  return <div className="skill-chip"><Sparkles size={13} /><span>{label}</span><button onClick={onRemove}><X size={13} /></button></div>
}
