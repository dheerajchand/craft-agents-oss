import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, realpathSync, mkdirSync, writeFileSync, readFileSync, rmSync, unlinkSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runWorkspaceCommandHooks } from '../core/workspace-command-hooks.ts';
import { PiAgent } from '../pi-agent.ts';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const workspace = realpathSync(mkdtempSync(join(tmpdir(), 'pi-managed-hooks-'))); roots.push(workspace);
  mkdirSync(join(workspace, '.claude'));
  // The managed Mac installer leaves SDK project discovery empty.
  writeFileSync(join(workspace, '.claude/settings.json'), JSON.stringify({ hooks: { UserPromptSubmit: [], PreToolUse: [], PostToolUse: [] } }));
  return { workspace, cwd: workspace, sessionId: 'own-session', sessionDir: join(workspace, 'sessions/own-session') };
}
function managed(c: ReturnType<typeof fixture>, hooks: Record<string, unknown>, env = {}) {
  const policyPath = join(c.workspace, '.claude/craft-settings.json');
  const text = JSON.stringify({ hooks, env }); writeFileSync(policyPath, text);
  const receipt = { schema_version: 1, state: 'active', workspace: c.workspace,
    policy_path: policyPath, policy_sha256: createHash('sha256').update(text).digest('hex') };
  writeFileSync(join(c.workspace, '.claude/craft-hook-registration.json'), JSON.stringify(receipt));
  return receipt;
}
function command(command: string) { return { type: 'command', command }; }
function agent(c: ReturnType<typeof fixture>) {
  return new PiAgent({ provider: 'pi', workspace: { id: 'managed-test', name: 'Managed', rootPath: c.workspace },
    session: { id: c.sessionId, workspaceRootPath: c.workspace, workingDirectory: c.cwd, createdAt: Date.now(), lastUsedAt: Date.now() }, isHeadless: true } as any);
}

describe('Pi managed workspace policy selection', () => {
  it('runs the registered 48-command Mac layout instead of its empty discovery stub', async () => {
    const c = fixture();
    const make = (count: number, matcher?: string) => ({ ...(matcher ? { matcher } : {}), hooks: Array.from({ length: count }, () => command('printf x >> selected-events')) });
    // Actual installed Mac event/group/matcher cardinalities, with harmless commands.
    const hooks = { UserPromptSubmit: [make(7), make(1)],
      PreToolUse: [make(16, 'Bash'), make(4, 'Edit'), make(4, 'MultiEdit'), make(4, 'NotebookEdit'), make(4, 'Write'), make(2, 'mcp__session__send_agent_message'), make(2, 'mcp__session__spawn_session'), make(1, 'mcp__.*github.*create_branch')],
      PostToolUse: [make(1, 'Bash'), make(1, 'mcp__session__spawn_session')],
      PostToolUseFailure: [make(1, 'mcp__session__spawn_session')] };
    expect(Object.values(hooks).flatMap(groups => groups.flatMap(g => g.hooks))).toHaveLength(48);
    managed(c, hooks);
    await runWorkspaceCommandHooks('UserPromptSubmit', {}, c);
    await runWorkspaceCommandHooks('PreToolUse', { tool_name: 'Bash' }, c);
    await runWorkspaceCommandHooks('PreToolUse', { tool_name: 'Write' }, c);
    await runWorkspaceCommandHooks('PostToolUse', { tool_name: 'Bash' }, c);
    await runWorkspaceCommandHooks('PostToolUseFailure', { tool_name: 'mcp__session__spawn_session' }, c);
    expect(readFileSync(join(c.workspace, 'selected-events'), 'utf8')).toBe('x'.repeat(30));
  });
  it('blocks an actual Pi pre-tool request using the selected managed policy', async () => {
    const c = fixture(); managed(c, { PreToolUse: [{ matcher: 'Write', hooks: [command('echo managed-outside-scope >&2; exit 2')] }] });
    const a = agent(c); const sent: any[] = []; (a as any).send = (v: unknown) => sent.push(v);
    try { await (a as any).handlePreToolUseRequest({ requestId: 'managed-write', toolName: 'Write', toolCallId: 'own-call', input: { file_path: join(c.workspace, 'outside') } }); }
    finally { a.destroy(); }
    expect(sent).toEqual([{ type: 'pre_tool_use_response', requestId: 'managed-write', action: 'block', reason: 'Workspace PreToolUse hook 1.1: managed-outside-scope' }]);
  });
  it('allows a safe actual Pi request after the managed command permits it', async () => {
    const c = fixture(); managed(c, { PreToolUse: [{ matcher: 'Read', hooks: [command('printf checked > allowed-marker')] }] });
    const a = agent(c); const sent: any[] = []; (a as any).send = (v: unknown) => sent.push(v);
    try { await (a as any).handlePreToolUseRequest({ requestId: 'managed-read', toolName: 'Read', input: { file_path: join(c.workspace, 'owned') } }); }
    finally { a.destroy(); }
    expect(readFileSync(join(c.workspace, 'allowed-marker'), 'utf8')).toBe('checked');
    expect(sent).toEqual([{ type: 'pre_tool_use_response', requestId: 'managed-read', action: 'allow' }]);
  });
  it('preserves unenrolled legacy Linux policy even when an undeclared Craft file exists', async () => {
    const c = fixture(); managed(c, { PreToolUse: [{ hooks: [command('exit 2')] }] });
    unlinkSync(join(c.workspace, '.claude/craft-hook-registration.json'));
    writeFileSync(join(c.workspace, '.claude/settings.json'), JSON.stringify({ hooks: { PreToolUse: [{ hooks: [command('printf legacy > legacy-marker')] }] } }));
    await runWorkspaceCommandHooks('PreToolUse', {}, c);
    expect(readFileSync(join(c.workspace, 'legacy-marker'), 'utf8')).toBe('legacy');
  });
  it('fails closed on a declared policy that is missing instead of falling back', async () => {
    const c = fixture(); managed(c, {}); unlinkSync(join(c.workspace, '.claude/craft-settings.json'));
    await expect(runWorkspaceCommandHooks('PreToolUse', {}, c)).rejects.toThrow();
  });
  it('fails closed on malformed declared policy even with a matching receipt digest', async () => {
    const c = fixture(); const receipt = managed(c, {}); const text = '{bad json';
    writeFileSync(receipt.policy_path, text); receipt.policy_sha256 = createHash('sha256').update(text).digest('hex');
    writeFileSync(join(c.workspace, '.claude/craft-hook-registration.json'), JSON.stringify(receipt));
    await expect(runWorkspaceCommandHooks('PreToolUse', {}, c)).rejects.toThrow();
  });
  it('rejects stale, malformed or differently bound registration without legacy fallback', async () => {
    for (const mutate of [(r: any) => { r.state = 'inactive'; }, (r: any) => { r.workspace += '-foreign'; },
      (r: any) => { r.policy_path = join(r.workspace, '.claude/settings.json'); }, (r: any) => { r.policy_sha256 = '0'.repeat(64); },
      (r: any) => { r.schema_version = 99; }]) {
      const c = fixture(); const receipt = managed(c, {}); mutate(receipt);
      writeFileSync(join(c.workspace, '.claude/craft-hook-registration.json'), JSON.stringify(receipt));
      await expect(runWorkspaceCommandHooks('PreToolUse', {}, c)).rejects.toThrow('managed workspace hook');
    }
    const c = fixture(); writeFileSync(join(c.workspace, '.claude/craft-hook-registration.json'), '{bad');
    await expect(runWorkspaceCommandHooks('PreToolUse', {}, c)).rejects.toThrow();
  });
  it('keeps policy environment and genuine Pi binding without changing the parent environment', async () => {
    const before = { ...process.env }; const c = fixture();
    managed(c, { PreToolUse: [{ hooks: [command('test "$MANAGED_SETTING" = kept && test "$CRAFT_SESSION_DIR" = "$CRAFT_AGENT_WORKSPACE/sessions/own-session" && printf bound > env-marker')] }] }, { MANAGED_SETTING: 'kept', CRAFT_SESSION_DIR: '/foreign' });
    await runWorkspaceCommandHooks('PreToolUse', {}, c);
    expect(readFileSync(join(c.workspace, 'env-marker'), 'utf8')).toBe('bound');
    expect(process.env).toEqual(before);
  });
});
