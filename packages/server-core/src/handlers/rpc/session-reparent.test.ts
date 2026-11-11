import { describe, expect, it } from 'bun:test'
import { registerSessionsHandlers } from './sessions'
import { RPC_CHANNELS } from '@craft-agent/shared/protocol'
import type { HandlerDeps } from '../handler-deps'
import type { HandlerFn, RpcServer } from '@craft-agent/server-core/transport'

describe('public session parent command dispatch', () => {
  it('forwards explicit parent and root to the manager without invoking other session actions', async () => {
    const handlers = new Map<string, HandlerFn>()
    const calls: unknown[][] = []
    registerSessionsHandlers({ handle(channel, handler) { handlers.set(channel, handler) } } as RpcServer, {
      sessionManager: { async setSessionParent(...args: unknown[]) { calls.push(args) } },
      platform: { logger: { info() {}, warn() {}, error() {}, debug() {} } },
    } as unknown as HandlerDeps)
    const command = handlers.get(RPC_CHANNELS.sessions.COMMAND)!
    const ctx = { clientId: 'client', workspaceId: 'ws', webContentsId: 1 }
    await command(ctx, 'child', { type: 'setParent', parentSessionId: 'tc' })
    await command(ctx, 'tc', { type: 'setParent', parentSessionId: null })
    expect(calls).toEqual([['child', 'tc'], ['tc', null]])
  })
})
