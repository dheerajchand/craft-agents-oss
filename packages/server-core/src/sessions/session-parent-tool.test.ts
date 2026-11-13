import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import ts from 'typescript'
import { SESSION_TOOL_REGISTRY, type SessionToolContext } from '@craft-agent/session-tools-core'
import { attachSessionSelfManagementBindings } from '@craft-agent/shared/agent/session-self-management-bindings'
import { registerSessionScopedToolCallbacks, unregisterSessionScopedToolCallbacks } from '@craft-agent/shared/agent/session-scoped-tool-callback-registry'
import { getSessionFilePath, loadSession, writeSessionJsonl, type StoredSession } from '@craft-agent/shared/sessions'
import { SessionManager, createManagedSession } from './SessionManager'

describe('registered native parent tool', () => {
  let root: string
  let manager: SessionManager
  let sessions: Map<string, ReturnType<typeof createManagedSession>>
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'parent-tool-'))
    manager = new SessionManager()
    sessions = (manager as any).sessions
    manager.setEventSink(() => {})
  })
  afterEach(async () => {
    unregisterSessionScopedToolCallbacks('wc')
    await manager.flushAllSessions()
    rmSync(root, { recursive: true, force: true })
  })

  function seed(id: string, parentSessionId?: string, workspaceId = 'workspace', rootPath = root) {
    const stored = { id, parentSessionId, workspaceRootPath: rootPath, name: id,
      model: 'preserve-model', llmConnection: 'preserve-provider', permissionMode: 'ask',
      labels: ['preserve'], sessionStatus: 'needs-review', createdAt: 1, lastUsedAt: 2,
      messages: [{ id: 'pending', type: 'user', content: 'unfinished work', timestamp: 1, isQueued: true }],
    } as unknown as StoredSession
    const path = getSessionFilePath(rootPath, id)
    mkdirSync(dirname(path), { recursive: true })
    writeSessionJsonl(path, stored)
    const managed = createManagedSession({ ...stored, messages: [] },
      { id: workspaceId, slug: workspaceId, name: workspaceId, rootPath, createdAt: 1 })
    sessions.set(id, managed)
    return managed
  }

  function context(caller: ReturnType<typeof seed>) {
    // Execute the actual registered callback initializer. This catches a missing
    // workspace check without constructing credential-backed agent factories.
    const path = new URL('./SessionManager.ts', import.meta.url)
    const source = ts.createSourceFile(path.pathname, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true)
    const expressions: ts.Expression[] = []
    function visit(n: ts.Node) {
      if (ts.isCallExpression(n) && n.expression.getText(source) === 'mergeSessionScopedToolCallbacks') {
        const callbacks = n.arguments[1]
        if (callbacks && ts.isObjectLiteralExpression(callbacks)) {
          for (const field of callbacks.properties) {
            if (ts.isPropertyAssignment(field) && field.name.getText(source) === 'setSessionParentFn') expressions.push(field.initializer)
          }
        }
      }
      ts.forEachChild(n, visit)
    }
    visit(source)
    expect(expressions).toHaveLength(1)
    const text = new Bun.Transpiler({ loader: 'ts' }).transformSync(
      'function registered(managed) { return ' + expressions[0]!.getText(source) + '; }')
    const callback = new Function(text + '; return registered;')().call(manager, caller)
    registerSessionScopedToolCallbacks(caller.id, { setSessionParentFn: callback })
    const ctx = { sessionId: caller.id } as SessionToolContext
    attachSessionSelfManagementBindings(ctx, caller.id)
    return ctx
  }

  async function invoke(ctx: SessionToolContext, sessionId: string | undefined, parentSessionId: string | null) {
    const tool = SESSION_TOOL_REGISTRY.get('set_session_parent')!
    return tool.handler!(ctx, tool.inputSchema.parse({ sessionId, parentSessionId }))
  }

  it('moves a hub and root steward through the real tool, binding and persistence paths', async () => {
    const wc = seed('wc')
    seed('tc')
    const hub = seed('hub', 'wc')
    const before = loadSession(root, 'hub')!
    const ctx = context(wc)
    expect((await invoke(ctx, 'hub', 'tc')).isError).toBeFalsy()
    const after = loadSession(root, 'hub')!
    expect({ ...after, lastUsedAt: 0 }).toEqual({ ...before, parentSessionId: 'tc', lastUsedAt: 0 })
    expect(Boolean(hub.agent)).toBe(false)
    expect(hub.isProcessing).toBe(false)
    expect((await invoke(ctx, undefined, null)).isError).toBeFalsy()
    expect(loadSession(root, 'wc')?.parentSessionId).toBeUndefined()
  })

  it('rejects foreign target roots, foreign parents, cycles and missing targets without changing files', async () => {
    const wc = seed('wc')
    seed('hub', 'wc')
    seed('foreign', undefined, 'foreign')
    seed('other-root', undefined, 'workspace', join(root, 'elsewhere'))
    const ctx = context(wc)
    for (const [id, parent] of [['foreign', null], ['other-root', null], ['wc', 'foreign'], ['wc', 'hub'], ['missing', null]] as const) {
      expect((await invoke(ctx, id, parent)).isError).toBe(true)
    }
    expect(loadSession(root, 'hub')?.parentSessionId).toBe('wc')
    expect(loadSession(root, 'wc')?.parentSessionId).toBeUndefined()
    expect(loadSession(root, 'foreign')?.parentSessionId).toBeUndefined()
  })

  it('uses callback availability at call time rather than caching a missing backend', async () => {
    const wc = seed('wc')
    seed('tc')
    seed('hub', 'wc')
    const ctx = context(wc)
    const callback = ctx.setSessionParent!
    unregisterSessionScopedToolCallbacks('wc')
    expect((await invoke(ctx, 'hub', 'tc')).isError).toBe(true)
    expect(loadSession(root, 'hub')?.parentSessionId).toBe('wc')
    registerSessionScopedToolCallbacks('wc', { setSessionParentFn: callback })
    expect((await invoke(ctx, 'hub', 'tc')).isError).toBeFalsy()
    expect(loadSession(root, 'hub')?.parentSessionId).toBe('tc')
  })
});
