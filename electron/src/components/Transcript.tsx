import { ArrowDown } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent } from 'react'
import { FileContextMenu, type ResourceMenuState } from './FileContextMenu'
import { TaskActivity } from './TranscriptActivity'
import { TranscriptEmptyState, TranscriptItemBlock } from './TranscriptMessageBlocks'
import { isExternalResourceTarget, normalizeFileTarget, openExternalResource, safeResourceTarget } from './transcript-resource'
import type { ThreadItem } from '../types'
import { isAssistantMessage, isPlanStep, isToolCall, isToolResult } from '../types'

interface Props {
  items: ThreadItem[]
  displayName: string
  planSinceIndex?: number
  onOpenPath: (path: string) => void
  onError?: (message: string) => void
  planMode?: boolean
  onAcceptPlan?: (planText: string) => void
  onRevisePlan?: (planText: string) => void
  onCancelPlan?: () => void
}

interface MessageBlock {
  kind: 'message'
  item: ThreadItem
}

interface ActivityBlock {
  kind: 'activity'
  id: string
  items: ThreadItem[]
}

type TranscriptBlock = MessageBlock | ActivityBlock

export function Transcript({ items, displayName, onOpenPath, onError, planMode, planSinceIndex, onAcceptPlan, onRevisePlan, onCancelPlan }: Props) {
  const transcriptRef = useRef<HTMLElement>(null)
  const stickToBottomRef = useRef(true)
  const [resourceMenu, setResourceMenu] = useState<ResourceMenuState | null>(null)
  const [showJumpToLatest, setShowJumpToLatest] = useState(false)
  const blocks = useMemo(() => buildBlocks(items), [items])
  const actionablePlanId = useMemo(() => findActionablePlanId(items, planMode, planSinceIndex), [items, planMode, planSinceIndex])

  useEffect(() => {
    const transcript = transcriptRef.current
    if (!transcript) return () => {}
    if (stickToBottomRef.current) {
      transcript.scrollTop = transcript.scrollHeight
      setShowJumpToLatest(false)
    } else {
      setShowJumpToLatest(true)
    }
    return () => {}
  }, [items])

  const handleScroll = useCallback(() => {
    const transcript = transcriptRef.current
    if (!transcript) return
    const atBottom = transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight < 72
    stickToBottomRef.current = atBottom
    setShowJumpToLatest(!atBottom)
  }, [])

  const jumpToLatest = useCallback(() => {
    const transcript = transcriptRef.current
    if (!transcript) return
    stickToBottomRef.current = true
    transcript.scrollTo({ top: transcript.scrollHeight, behavior: 'smooth' })
    setShowJumpToLatest(false)
  }, [])

  const openResource = useCallback((target: string) => {
    const safeTarget = safeResourceTarget(target)
    if (!safeTarget) { onError?.('已阻止无效或不安全的资源链接'); return }
    if (isExternalResourceTarget(safeTarget)) {
      void openExternalResource(safeTarget).catch((error) => onError?.(String(error)))
      return
    }
    onOpenPath(normalizeFileTarget(safeTarget))
  }, [onError, onOpenPath])

  const contextResource = useCallback((event: MouseEvent, target: string) => {
    const safeTarget = safeResourceTarget(target)
    if (!safeTarget) return
    setResourceMenu({
      target: isExternalResourceTarget(safeTarget) ? safeTarget : normalizeFileTarget(safeTarget),
      x: event.clientX,
      y: event.clientY,
    })
  }, [])

  const closeResourceMenu = useCallback(() => setResourceMenu(null), [])

  return <main ref={transcriptRef} className="transcript" aria-label="会话记录" onScroll={handleScroll}>
    <span className="sr-only" role="status" aria-live="polite">{items.some((item) => item.status === 'in_progress') ? 'Agent 正在处理' : '会话已更新'}</span>
    <div className="transcript-inner">
      {items.length === 0 ? <TranscriptEmptyState displayName={displayName} /> : null}
      {blocks.map((block) => block.kind === 'activity'
        ? <TaskActivity key={block.id} items={block.items} onOpenResource={openResource} onContextResource={contextResource} />
        : <TranscriptItemBlock
            key={block.item.id}
            item={block.item}
            displayName={displayName}
            onOpenResource={openResource}
            onContextResource={contextResource}
            displayPlan={Boolean(planMode)}
            actionablePlan={block.item.id === actionablePlanId}
            onAcceptPlan={onAcceptPlan}
            onRevisePlan={onRevisePlan}
            onCancelPlan={onCancelPlan}
          />)}
    </div>
    {showJumpToLatest ? <button type="button" className="scroll-latest-button" onClick={jumpToLatest} aria-label="查看最新消息"><ArrowDown size={14} />查看最新</button> : null}
    {resourceMenu ? <FileContextMenu menu={resourceMenu} onClose={closeResourceMenu} onError={onError} /> : null}
  </main>
}

function findActionablePlanId(items: ThreadItem[], planMode?: boolean, planSinceIndex?: number) {
  if (!planMode) return ''
  const candidate = [...items].reverse().find((item, reverseIndex) => {
    const itemIndex = items.length - 1 - reverseIndex
    if (itemIndex < (planSinceIndex ?? 0)) return false
    return (isPlanStep(item) && item.steps.length > 0) ||
      (isAssistantMessage(item) && item.status === 'completed' && Boolean(item.content.trim()))
  })
  return candidate?.id ?? ''
}

function buildBlocks(items: ThreadItem[]): TranscriptBlock[] {
  const blocks: TranscriptBlock[] = []
  let activity: ThreadItem[] = []

  const flush = () => {
    const first = activity[0]
    if (!first) return
    blocks.push({ kind: 'activity', id: `activity_${first.id}`, items: activity })
    activity = []
  }

  for (const item of items) {
    if (isToolResult(item) || isToolCall(item)) { activity.push(item); continue }
    if (isAssistantMessage(item) && !item.content.trim() && item.hasToolCalls) continue
    if (isAssistantMessage(item) && !item.content.trim() && activity.length) continue
    flush()
    blocks.push({ kind: 'message', item })
  }
  flush()
  return blocks
}
