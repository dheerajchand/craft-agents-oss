import { describe, it, expect } from 'bun:test';
import type { SessionToolContext } from '../context.ts';
import { SetSessionParentSchema, SESSION_TOOL_REGISTRY, getSessionToolNames } from '../tool-defs.ts';
import { handleSetSessionParent } from './set-session-parent.ts';

describe('native session parent control', () => {
  it('requires an explicit parent or root and blocks safe mode', () => {
    expect(SetSessionParentSchema.safeParse({}).success).toBe(false);
    expect(SetSessionParentSchema.safeParse({ parentSessionId: null }).success).toBe(true);
    expect(SESSION_TOOL_REGISTRY.get('set_session_parent')?.safeMode).toBe('block');
    expect(getSessionToolNames({ profile: 'coding' })).toContain('set_session_parent');
  });

  it('does not report success without a backend or with an invalid parent', async () => {
    const ctx = {} as SessionToolContext;
    expect((await handleSetSessionParent(ctx, { parentSessionId: null })).isError).toBe(true);
    let called = false;
    ctx.setSessionParent = async () => { called = true; };
    expect((await handleSetSessionParent(ctx, { parentSessionId: undefined as never })).isError).toBe(true);
    expect((await handleSetSessionParent(ctx, { parentSessionId: '   ' })).isError).toBe(true);
    expect(called).toBe(false);
  });

  it('awaits durable backend success and returns a failure when persistence rejects', async () => {
    const calls: unknown[] = [];
    const ctx = { setSessionParent: async (...args: unknown[]) => { calls.push(args); } } as unknown as SessionToolContext;
    expect((await handleSetSessionParent(ctx, { sessionId: 'hub', parentSessionId: 'tc' })).isError).toBeFalsy();
    expect((await handleSetSessionParent(ctx, { parentSessionId: null })).isError).toBeFalsy();
    expect(calls).toEqual([['hub', 'tc'], [undefined, null]]);
    ctx.setSessionParent = async () => { throw new Error('disk unavailable'); };
    const result = await handleSetSessionParent(ctx, { parentSessionId: null });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('disk unavailable');
  });
});
