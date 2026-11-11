import { afterEach, describe, expect, it } from 'bun:test'
import { deserializeEnvelope, serializeEnvelope } from '@craft-agent/server-core/transport'
import { main, parseArgs, parseSessionReparent } from './index'

describe('session reparent CLI', () => {
  const servers: ReturnType<typeof Bun.serve>[] = []
  afterEach(() => { for (const server of servers.splice(0)) server.stop(true) })

  it('requires an explicit parent or root and rejects ambiguous or extra arguments', () => {
    expect(parseSessionReparent(['child', '--parent', 'tc'])).toEqual({ sessionId: 'child', parentSessionId: 'tc' })
    expect(parseSessionReparent(['tc', '--root'])).toEqual({ sessionId: 'tc', parentSessionId: null })
    for (const args of [[], ['child'], ['child', '--parent'], ['child', '--root', '--parent', 'tc'],
      ['child', '--root', '--root'], ['child', '--parent', 'tc', '--parent', 'wc'],
      ['child', '--parent', '--root'], ['child', '--unknown'], ['--root', 'child'], ['child', '--root', 'other']]) {
      expect(() => parseSessionReparent(args)).toThrow('Usage: session reparent')
    }
    expect(parseArgs(['bun', 'cli', '--json', 'session', 'reparent', 'child', '--parent', 'tc']).rest)
      .toEqual(['reparent', 'child', '--parent', 'tc'])
  })

  it('sends both CLI forms as exact public session commands over the RPC transport', async () => {
    const requests: { channel?: string; args?: unknown[] }[] = []
    const server = Bun.serve({
      port: 0,
      fetch(req, svr) { return svr.upgrade(req) ? undefined : new Response('not found', { status: 404 }) },
      websocket: {
        message(ws, raw) {
          const envelope = deserializeEnvelope(typeof raw === 'string' ? raw : new TextDecoder().decode(raw))
          if (envelope.type === 'handshake') {
            ws.send(serializeEnvelope({ id: envelope.id, type: 'handshake_ack', clientId: 'reparent-test', protocolVersion: '1.0' }))
          } else if (envelope.type === 'request') {
            requests.push({ channel: envelope.channel, args: envelope.args })
            ws.send(serializeEnvelope({ id: envelope.id, type: 'response', channel: envelope.channel, result: null }))
          }
        },
      },
    })
    servers.push(server)
    const base = ['bun', 'cli', '--url', `ws://localhost:${server.port}`, '--json', 'session', 'reparent']
    await main([...base, 'child', '--parent', 'tc'])
    await main([...base, 'tc', '--root'])
    expect(requests).toEqual([
      { channel: 'sessions:command', args: ['child', { type: 'setParent', parentSessionId: 'tc' }] },
      { channel: 'sessions:command', args: ['tc', { type: 'setParent', parentSessionId: null }] },
    ])
  })
})
