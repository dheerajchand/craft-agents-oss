import { describe, expect, it } from 'bun:test'
import { createStore } from 'jotai'
import { sessionAtomFamily, sessionMetaMapAtom, updateSessionAtom } from '../../../atoms/sessions'
import { processEvent } from '../../processor'
import { handleSessionMetadataChanged } from '../session'
import type { SessionMetadataChangedEvent, SessionState } from '../../types'

describe('session parent metadata transport', () => {
  function state(): SessionState {
    return {
      session: { id: 'child', workspaceId: 'ws', workspaceName: 'Workspace', name: 'Preserved',
        parentSessionId: 'old', messages: [], isProcessing: true, lastMessageAt: 7, labels: ['keep'], isArchived: true },
      streaming: { messageId: 'stream', content: 'pending' } as SessionState['streaming'],
    }
  }
  function delivered(changes: SessionMetadataChangedEvent['changes']): SessionMetadataChangedEvent {
    return JSON.parse(JSON.stringify({ type: 'session_metadata_changed', sessionId: 'child', changes }))
  }
  it('applies new parent and clears it with a JSON-serializable null without losing other state', () => {
    const initial = state()
    const moved = handleSessionMetadataChanged(initial, delivered({ parentSessionId: 'new' })).state
    expect(moved.session).toEqual({ ...initial.session, parentSessionId: 'new' })
    const detached = handleSessionMetadataChanged(moved, delivered({ parentSessionId: null })).state
    expect(detached.session).toEqual({ ...initial.session, parentSessionId: undefined })
    expect(detached.streaming).toBe(initial.streaming)
    expect(initial.session.parentSessionId).toBe('old')
  })
  it('updates the actual session metadata map used for sidebar and kanban hierarchy', () => {
    const store = createStore()
    const initial = state()
    store.set(updateSessionAtom, 'child', () => initial.session)
    for (const parentSessionId of ['new', null]) {
      const current = store.get(sessionAtomFamily('child'))!
      const result = processEvent({ session: current, streaming: null }, delivered({ parentSessionId }))
      store.set(updateSessionAtom, 'child', () => result.state.session)
      const meta = store.get(sessionMetaMapAtom).get('child')!
      expect(meta.parentSessionId).toBe(parentSessionId ?? undefined)
      expect(meta.labels).toEqual(['keep'])
      expect(meta.isArchived).toBe(true)
      expect(meta.isProcessing).toBe(true)
      expect(meta.name).toBe('Preserved')
      expect(store.get(sessionAtomFamily('child'))?.parentSessionId).toBe(parentSessionId ?? undefined)
    }
  })
  it('unrelated metadata changes leave the parent intact', () => {
    const initial = state()
    const result = handleSessionMetadataChanged(initial, delivered({ taskNodeCount: 8 })).state
    expect(result.session).toEqual({ ...initial.session, taskNodeCount: 8 })
  })
})
