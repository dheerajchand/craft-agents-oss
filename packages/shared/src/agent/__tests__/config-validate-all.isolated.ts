import { afterAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// This file runs in its own process: shared config paths are fixed on import.
const directory = mkdtempSync(join(tmpdir(), 'claude-config-validate-all-'));
const previousConfigDir = process.env.CRAFT_CONFIG_DIR;
process.env.CRAFT_CONFIG_DIR = join(directory, 'config');
mkdirSync(process.env.CRAFT_CONFIG_DIR, { recursive: true });
writeFileSync(join(process.env.CRAFT_CONFIG_DIR, 'config.json'), JSON.stringify({
  workspaces: [], activeWorkspaceId: null, activeSessionId: null,
}));
writeFileSync(join(process.env.CRAFT_CONFIG_DIR, 'preferences.json'), '{}');

const { createClaudeContext } = await import('../claude-context.ts');
const { handleConfigValidate } = await import('../../../../session-tools-core/src/handlers/config-validate.ts');
const workspacePath = join(directory, 'workspace');
mkdirSync(join(workspacePath, 'sources'), { recursive: true });
const context = createClaudeContext({
  sessionId: 'validation-fixture', workspaceId: 'different-from-root', workspacePath,
  onPlanSubmitted: () => {}, onAuthRequest: () => {},
});
const automationFile = join(workspacePath, 'automations.json');
const text = (result: Awaited<ReturnType<typeof handleConfigValidate>>) => result.content[0]?.text ?? '';

afterAll(() => {
  if (previousConfigDir === undefined) delete process.env.CRAFT_CONFIG_DIR;
  else process.env.CRAFT_CONFIG_DIR = previousConfigDir;
  rmSync(directory, { recursive: true, force: true });
});

describe('Claude config_validate all workspace dispatch', () => {
  it('reports the same invalid automation as the explicit target', async () => {
    writeFileSync(automationFile, JSON.stringify({ automations: {
      SchedulerTick: [{ cron: '*/5 * * * *', actions: [{ type: 'command', command: 'echo fixture' }] }],
    } }));
    const target = text(await handleConfigValidate(context, { target: 'automations' }));
    const all = text(await handleConfigValidate(context, { target: 'all' }));
    expect(target).toContain('automations.SchedulerTick.0.actions.0.type');
    expect(all).toContain('automations.SchedulerTick.0.actions.0.type');
    expect(all).not.toContain('Validation passed');
  });

  it('accepts a valid workspace automation configuration', async () => {
    writeFileSync(automationFile, JSON.stringify({ automations: {} }));
    expect(text(await handleConfigValidate(context, { target: 'automations' }))).toContain('Validation passed');
    expect(text(await handleConfigValidate(context, { target: 'all' }))).toContain('Validation passed');
  });

  it('also includes workspace statuses while retaining source validation', async () => {
    mkdirSync(join(workspacePath, 'statuses'), { recursive: true });
    writeFileSync(join(workspacePath, 'statuses', 'config.json'), '{invalid');
    const source = join(workspacePath, 'sources', 'invalid-source');
    mkdirSync(source, { recursive: true });
    writeFileSync(join(source, 'config.json'), '{invalid');
    const all = context.validators!.validateAll(workspacePath);
    expect(all.errors.some(error => 'file' in error && error.file === 'statuses/config.json')).toBe(true);
    expect(all.errors.some(error => 'file' in error && typeof error.file === 'string' && error.file.includes('invalid-source'))).toBe(true);
  });
});
