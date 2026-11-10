import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, realpathSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runWorkspaceCommandHooks } from '../core/workspace-command-hooks.ts';
import { PiAgent } from '../pi-agent.ts';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture(hooks: Record<string, unknown>, env = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pi-workspace-hooks-'))); roots.push(root);
  mkdirSync(join(root, '.claude'));
  writeFileSync(join(root, '.claude/settings.json'), JSON.stringify({ hooks, env }));
  return { workspace: root, cwd: root, sessionId: 'own-session', sessionDir: join(root, 'sessions/own-session') };
}
function group(command: string, extra = {}) { return [{ matcher: '*', hooks: [{ type: 'command', command, ...extra }] }]; }

describe('Pi workspace command hooks', () => {
  it('executes the actual configured command before replying to a Pi tool request and propagates denial', async () => {
    const c = fixture({ PreToolUse: group("printf '{\"hookSpecificOutput\":{\"permissionDecision\":\"deny\",\"permissionDecisionReason\":\"outside assigned scope\"}}'") });
    const agent = new PiAgent({ provider: 'pi', workspace: { id: 'hook-test', name: 'Hooks', rootPath: c.workspace }, session: { id: c.sessionId, workspaceRootPath: c.workspace, workingDirectory: c.cwd, createdAt: Date.now(), lastUsedAt: Date.now() }, isHeadless: true } as any);
    const sent: any[] = []; (agent as any).send = (value: unknown) => sent.push(value);
    await (agent as any).handlePreToolUseRequest({ requestId: 'private-write', toolName: 'Write', toolCallId: 'actual-call-id', input: { file_path: join(c.workspace, 'out-of-scope') } });
    expect(sent).toEqual([{ type: 'pre_tool_use_response', requestId: 'private-write', action: 'block', reason: 'outside assigned scope' }]);
    agent.destroy();
  });
  it('awaits a prompt-hook denial before starting the Pi subprocess', async () => {
    const c = fixture({ UserPromptSubmit: group('echo prompt-hook-denied >&2; exit 2') });
    const agent = new PiAgent({ provider: 'pi', workspace: { id: 'hook-test', name: 'Hooks', rootPath: c.workspace }, session: { id: c.sessionId, workspaceRootPath: c.workspace, workingDirectory: c.cwd, createdAt: Date.now(), lastUsedAt: Date.now() }, isHeadless: true } as any);
    let started = false;
    (agent as any).ensureSubprocess = async () => { started = true; throw new Error('must not start'); };
    const events: any[] = [];
    for await (const event of (agent as any).chatImpl('private test')) events.push(event);
    agent.destroy();
    expect(started).toBe(false);
    expect(events.some(event => event.type === 'error' && event.message.includes('prompt-hook-denied'))).toBe(true);
    expect(events.at(-1)?.type).toBe('complete');
  });
  it('carries the actual Pi tool id through successful and failed post-tool events', async () => {
    for (const failed of [false, true]) {
      const event = failed ? 'PostToolUseFailure' : 'PostToolUse';
      const c = fixture({ [event]: group('cat > post-event.json') });
      const agent = new PiAgent({ provider: 'pi', workspace: { id: 'hook-test', name: 'Hooks', rootPath: c.workspace }, session: { id: c.sessionId, workspaceRootPath: c.workspace, workingDirectory: c.cwd, createdAt: Date.now(), lastUsedAt: Date.now() }, isHeadless: true } as any);
      (agent as any).handleSubprocessEvent({ type: 'tool_execution_start', toolName: 'Write', toolCallId: 'paired-tool-1', args: { file_path: '/private-fixture' } });
      (agent as any).handleSubprocessEvent({ type: 'tool_execution_end', toolName: 'Write', toolCallId: 'paired-tool-1', result: { content: [{ type: 'text', text: 'private result' }] }, isError: failed });
      let payload: any;
      for (let attempt = 0; attempt < 100; attempt++) {
        try { payload = JSON.parse(readFileSync(join(c.cwd, 'post-event.json'), 'utf8')); break; } catch { await Bun.sleep(10); }
      }
      expect((agent as any).workspaceHookToolInputs.size).toBe(0);
      agent.destroy();
      expect(payload?.hook_event_name).toBe(event);
      expect(payload?.tool_use_id).toBe('paired-tool-1');
      expect(payload?.tool_input?.file_path).toBe('/private-fixture');
      expect(payload?.session_id).toBe(c.sessionId);
    }
  });
  it('delivers genuine session, cwd, tool id and settings environment to stdin/env without changing parent env', async () => {
    const before = { ...process.env };
    const c = fixture({ PreToolUse: group('python3 -c \'import os,sys,json; p=json.load(sys.stdin); assert p["session_id"]=="own-session" and p["tool_use_id"]=="call1" and p["cwd"]==os.getcwd(); assert os.environ["CRAFT_SESSION_DIR"].endswith("sessions/own-session"); assert os.environ["OWN_SETTING"]=="kept"\'') }, { OWN_SETTING: 'kept', CRAFT_SESSION_DIR: '/foreign' });
    await runWorkspaceCommandHooks('PreToolUse', { tool_name: 'Write', tool_use_id: 'call1' }, c);
    expect(process.env).toEqual(before);
  });
  it('does not run nonmatching tools', async () => {
    const c = fixture({ PreToolUse: [{ matcher: '^Bash$', hooks: [{ type: 'command', command: 'exit 2' }] }] });
    await runWorkspaceCommandHooks('PreToolUse', { tool_name: 'Read' }, c);
  });
  it('propagates command exit 2 and stops later commands', async () => {
    const c = fixture({ PreToolUse: [{ hooks: [{ type: 'command', command: 'echo forbidden >&2; exit 2' }, { type: 'command', command: 'touch should-not-exist' }] }] });
    await expect(runWorkspaceCommandHooks('PreToolUse', {}, c)).rejects.toThrow('forbidden');
    expect(() => readFileSync(join(c.cwd, 'should-not-exist'))).toThrow();
  });
  for (const output of ['{"continue":false,"stopReason":"blocked"}', '{"decision":"block","reason":"blocked"}']) {
    it('propagates JSON blocking output '+output, async () => {
      const c = fixture({ PreToolUse: group(`printf '%s' '${output}'`) });
      await expect(runWorkspaceCommandHooks('PreToolUse', {}, c)).rejects.toThrow('blocked');
    });
  }
  for (const output of ['{"hookSpecificOutput":{"permissionDecision":"ask"}}', '{"hookSpecificOutput":{"updatedInput":{"command":"changed"}}}']) {
    it('does not silently allow unsupported enforcing output '+output, async () => {
      const c = fixture({ PreToolUse: group(`printf '%s' '${output}'`) });
      await expect(runWorkspaceCommandHooks('PreToolUse', {}, c)).rejects.toThrow();
    });
  }
  it('times out and kills a blocking hook', async () => {
    const c = fixture({ PreToolUse: group('sleep 30', { timeout: 0.02 }) });
    await expect(runWorkspaceCommandHooks('PreToolUse', {}, c)).rejects.toThrow('timed out');
  });
  it('honors cancellation before command execution', async () => {
    const c = fixture({ PreToolUse: group('touch should-not-exist') });
    const controller = new AbortController(); controller.abort();
    await expect(runWorkspaceCommandHooks('PreToolUse', {}, { ...c, signal: controller.signal })).rejects.toThrow('aborted');
    expect(() => readFileSync(join(c.cwd, 'should-not-exist'))).toThrow();
  });
  it('bounds output', async () => {
    const c = fixture({ PreToolUse: group('python3 -c \'print("x"*1100000)\'') });
    await expect(runWorkspaceCommandHooks('PreToolUse', {}, c)).rejects.toThrow('output exceeded');
  });
  it('fails closed on invalid settings and malformed JSON output', async () => {
    const c = fixture({ PreToolUse: group("printf '{broken'") });
    await expect(runWorkspaceCommandHooks('PreToolUse', {}, c)).rejects.toThrow('Invalid workspace hook JSON');
    writeFileSync(join(c.workspace, '.claude/settings.json'), '{broken');
    await expect(runWorkspaceCommandHooks('PreToolUse', {}, c)).rejects.toThrow();
  });
  it('runs prompt, post-tool and stop commands without reinterpreting automations', async () => {
    const c = fixture(Object.fromEntries(['UserPromptSubmit', 'PostToolUse', 'PostToolUseFailure', 'Stop'].map(event => [event, group(`printf '${event}\\n' >> events`)])));
    for (const event of ['UserPromptSubmit', 'PostToolUse', 'PostToolUseFailure', 'Stop']) await runWorkspaceCommandHooks(event, {}, c);
    expect(readFileSync(join(c.cwd, 'events'), 'utf8')).toBe('UserPromptSubmit\nPostToolUse\nPostToolUseFailure\nStop\n');
  });
});
