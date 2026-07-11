import { describe, expect, it } from 'vitest'
import { extractSessionReferenceIds, stripSessionReferences } from './composer-utils'

describe('session reference clipboard parsing', () => {
  it('extracts both supported reference forms without duplicates', () => {
    expect(extractSessionReferenceIds('@session:task-1 ranparty://session/task_2 @session:task-1')).toEqual(['task-1', 'task_2'])
  })

  it('removes only reference tokens and preserves all surrounding instructions', () => {
    const value = '@session:task-1 Previous task\nPlease continue with the implementation.\nKeep this line too.'
    expect(stripSessionReferences(value, ['task-1'])).toBe('Previous task\nPlease continue with the implementation.\nKeep this line too.')
    expect(stripSessionReferences('Before @session:task-1 after', ['task-1'])).toBe('Before  after')
  })

  it('does not remove a longer id that merely shares a prefix', () => {
    expect(stripSessionReferences('@session:task-10 keep', ['task-1'])).toBe('@session:task-10 keep')
  })
})
