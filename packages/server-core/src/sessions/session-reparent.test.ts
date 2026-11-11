import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import { getSessionFilePath, loadSession, writeSessionJsonl, type StoredSession } from '@craft-agent/shared/sessions'
import { SessionManager, createManagedSession } from './SessionManager'

describe('session hierarchy changes', () => {
  let root: string
  let manager: SessionManager
  let sessions: Map<string, ReturnType<typeof createManagedSession>>
  let events: unknown[]
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'session-reparent-'))
    manager = new SessionManager()
    sessions = (manager as unknown as { sessions: typeof sessions }).sessions
    events = []
    manager.setEventSink((_channel, _target, event) => { events.push(event) })
  })
  afterEach(async () => {
    await manager.flushAllSessions()
    rmSync(root, { recursive: true, force: true })
  })

  function seed(id: string, parentSessionId?: string, options: { archived?: boolean; warm?: boolean; workspaceId?: string; rootPath?: string } = {}) {
    const rootPath = options.rootPath ?? root
    const stored = {
      id, workspaceRootPath: rootPath, parentSessionId,
      name: `${id} original name`, createdAt: 100, lastUsedAt: 200,
      sessionStatus: 'needs-review', labels: ['review-loop'],
      isArchived: options.archived ?? false, archivedAt: options.archived ? 150 : undefined,
      model: 'preserve-model', llmConnection: 'preserve-connection',
      pendingPlanExecution: { planPath: '/existing-plan', state: 'pending' },
      messages: [{ id: `${id}-queued`, type: 'user', content: 'pending return', timestamp: 120, isQueued: true }],
    } as unknown as StoredSession
    const path = getSessionFilePath(rootPath, id)
    mkdirSync(dirname(path), { recursive: true })
    writeSessionJsonl(path, stored)
    const managed = createManagedSession({ ...stored, messages: [] }, {
      id: options.workspaceId ?? 'workspace-1', slug: 'test', name: 'test', rootPath, createdAt: 1,
    })
    if (options.warm) {
      managed.messagesLoaded = true
      managed.messages = [{ id: `${id}-live`, role: 'assistant', content: 'live result', timestamp: 180 }]
    }
    sessions.set(id, managed)
    return managed
  }

  it('moves eight children and a steward to root durably without waking archived/queued work or altering subtrees', async () => {
    seed('wc')
    seed('old-tc', 'wc')
    seed('new-tc', 'wc')
    const children = Array.from({ length: 8 }, (_, n) => `child-${n}`)
    const before = new Map<string, StoredSession>()
    for (const [n, id] of children.entries()) {
      seed(id, 'old-tc', { archived: n === 0 })
      before.set(id, loadSession(root, id)!)
    }
    seed('grandchild', 'child-1', { archived: true })
    const grandchildBefore = loadSession(root, 'grandchild')
    const wake = spyOn(manager as any, 'processNextQueuedMessage').mockImplementation(() => {})
    await manager.setSessionParent('new-tc', null)
    for (const id of children) await manager.setSessionParent(id, 'new-tc')
    await new Promise(resolve => setImmediate(resolve))

    expect(loadSession(root, 'new-tc')?.parentSessionId).toBeUndefined()
    expect(sessions.get('new-tc')?.parentSessionId).toBeUndefined()
    for (const id of children) {
      const after = loadSession(root, id)!
      // Only parent and the persistence queue's write timestamp change.
      expect({ ...after, lastUsedAt: 0 }).toEqual({ ...before.get(id)!, parentSessionId: 'new-tc', lastUsedAt: 0 })
      expect(sessions.get(id)?.parentSessionId).toBe('new-tc')
      expect(sessions.get(id)?.messagesLoaded).toBe(false)
      expect(sessions.get(id)?.messageQueue).toEqual([])
      expect(sessions.get(id)?.isProcessing).toBe(false)
    }
    expect(loadSession(root, 'grandchild')).toEqual(grandchildBefore)
    expect(wake).not.toHaveBeenCalled()
    expect(events).toHaveLength(9)
    expect(events[0]).toEqual({ type: 'session_metadata_changed', sessionId: 'new-tc', changes: { parentSessionId: null } })
    wake.mockRestore()
  })

  it('persists current warm messages and preserves active queue/runtime references', async () => {
    seed('parent')
    const child = seed('warm', undefined, { warm: true })
    child.isProcessing = true
    child.messageQueue.push({ message: 'queued live', messageId: 'q-live' })
    const queue = child.messageQueue
    await manager.setSessionParent('warm', 'parent')
    expect(loadSession(root, 'warm')?.messages.map(message => message.id)).toEqual(['warm-live'])
    expect(child.isProcessing).toBe(true)
    expect(child.messageQueue).toBe(queue)
    expect(child.messageQueue).toEqual([{ message: 'queued live', messageId: 'q-live' }])
  })

  it('rejects missing sessions, invalid parents, self/deep cycles, cross-workspace ancestors without changing persisted state', async () => {
    seed('a')
    seed('b', 'a')
    seed('c', 'b')
    seed('foreign', undefined, { workspaceId: 'workspace-2' })
    seed('broken', 'missing')
    seed('existing-cycle-1', 'existing-cycle-2')
    seed('existing-cycle-2', 'existing-cycle-1')
    const before = loadSession(root, 'a')
    for (const parent of ['a', 'b', 'c', 'foreign', 'missing', 'broken', 'existing-cycle-1', '', '   ', undefined, 3]) {
      await expect(manager.setSessionParent('a', parent as any)).rejects.toThrow()
      expect(sessions.get('a')?.parentSessionId).toBeUndefined()
      expect(loadSession(root, 'a')).toEqual(before)
    }
    await expect(manager.setSessionParent('missing', null)).rejects.toThrow('Session not found')
    expect(events).toEqual([])
  })

  it('rejects same workspace ID with a different workspace path', async () => {
    seed('a')
    seed('other-root', undefined, { rootPath: join(root, 'elsewhere') })
    await expect(manager.setSessionParent('a', 'other-root')).rejects.toThrow('same workspace')
  })

  it('serializes graph validation before awaits so concurrent requests cannot form a cycle', async () => {
    seed('a')
    seed('b')
    const results = await Promise.allSettled([
      manager.setSessionParent('a', 'b'), manager.setSessionParent('b', 'a'),
    ])
    expect(results.map(result => result.status)).toEqual(['fulfilled', 'rejected'])
    expect(loadSession(root, 'a')?.parentSessionId).toBe('b')
    expect(loadSession(root, 'b')?.parentSessionId).toBeUndefined()
    expect(events).toHaveLength(1)
  })

  it('does not broadcast a stale parent when two moves of the same session overlap', async () => {
    seed('child')
    seed('first')
    seed('last')
    await Promise.all([
      manager.setSessionParent('child', 'first'),
      manager.setSessionParent('child', 'last'),
    ])
    expect(loadSession(root, 'child')?.parentSessionId).toBe('last')
    expect(sessions.get('child')?.parentSessionId).toBe('last')
    expect(events).toEqual([{ type: 'session_metadata_changed', sessionId: 'child', changes: { parentSessionId: 'last' } }])
  })

  it('reports failed storage instead of successful reparenting, and the same request can be retried', async () => {
    seed('child')
    seed('parent')
    // A directory occupying the atomic-write temp path produces a real
    // EISDIR write failure, without permissions assumptions or mocking fs.
    const obstruction = getSessionFilePath(root, 'child') + '.tmp'
    mkdirSync(obstruction)
    const log = spyOn(console, 'error').mockImplementation(() => {})
    try {
      await expect(manager.setSessionParent('child', 'parent')).rejects.toThrow('could not be persisted')
      expect(loadSession(root, 'child')?.parentSessionId).toBeUndefined()
      expect(events).toEqual([])
      rmSync(obstruction, { recursive: true })
      await manager.setSessionParent('child', 'parent')
      expect(loadSession(root, 'child')?.parentSessionId).toBe('parent')
      expect(events).toHaveLength(1)
    } finally { log.mockRestore() }
  })

  it('permits root repair of an existing broken chain and an idempotent no-op', async () => {
    seed('a', 'missing')
    await manager.setSessionParent('a', null)
    const disk = loadSession(root, 'a')
    await manager.setSessionParent('a', null)
    expect(loadSession(root, 'a')).toEqual(disk)
    expect(events).toHaveLength(1)
  })
})
