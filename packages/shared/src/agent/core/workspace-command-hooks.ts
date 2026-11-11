import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

export class WorkspaceCommandHookError extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = 'WorkspaceCommandHookError';
  }
}

export interface WorkspaceHookContext {
  workspace: string;
  sessionId: string;
  sessionDir: string;
  cwd: string;
  signal?: AbortSignal;
}

// These are trusted, locally configured commands, as with Claude SDK hooks.
// This is deliberately separate from prompt-based automations.json actions.
export async function runWorkspaceCommandHooks(
  event: string, input: Record<string, unknown>, context: WorkspaceHookContext,
): Promise<void> {
  let text: string;
  try { text = await readFile(join(context.workspace, '.claude', 'settings.json'), 'utf8'); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  const settings = JSON.parse(text);
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)
    || (settings.hooks !== undefined && (!settings.hooks || typeof settings.hooks !== 'object'
      || Array.isArray(settings.hooks)))) throw new Error('Invalid workspace hook settings');
  const groups = settings.hooks?.[event];
  if (groups === undefined) return;
  if (!Array.isArray(groups)) throw new Error(`Invalid ${event} command hooks`);
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const [key, value] of Object.entries(settings.env ?? {})) {
    if (typeof value !== 'string') throw new Error('Invalid hook environment');
    env[key] = value;
  }
  Object.assign(env, {
    CRAFT_AGENT_WORKSPACE: context.workspace,
    CRAFT_WORKSPACE_PATH: context.workspace,
    CRAFT_SESSION_DIR: context.sessionDir,
  });
  const payload = JSON.stringify({ ...input, hook_event_name: event,
    session_id: context.sessionId, cwd: context.cwd });
  for (const [groupIndex, group] of groups.entries()) {
    if (group.matcher && group.matcher !== '*'
      && !new RegExp(group.matcher).test(String(input.tool_name ?? ''))) continue;
    if (!Array.isArray(group.hooks)) throw new Error(`Invalid ${event} hook group`);
    for (const [hookIndex, hook] of group.hooks.entries()) {
      if (hook.type !== 'command') throw new Error('Unsupported workspace hook type');
      if (typeof hook.command !== 'string' || !hook.command.trim()) throw new Error('Invalid hook command');
      const seconds = hook.timeout ?? 60;
      if (!Number.isFinite(seconds) || seconds <= 0 || seconds > 600) throw new Error('Invalid hook timeout');
      try {
        await executeCommand(hook.command, payload, env, context, seconds * 1000);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        // Identify the configured hook without exposing command arguments,
        // environment values, or the submitted tool/prompt payload.
        throw new Error(`Workspace ${event} hook ${groupIndex + 1}.${hookIndex + 1}: ${detail.slice(0, 4096)}`, { cause: error });
      }
    }
  }
}

function executeCommand(command: string, payload: string, env: NodeJS.ProcessEnv,
  context: WorkspaceHookContext, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    if (context.signal?.aborted) { reject(new Error('Workspace hook aborted')); return; }
    const child = spawn('/bin/sh', ['-c', command], {
      cwd: context.cwd, env, stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32',
    });
    let output = '', stderr = '', bytes = 0, failure: Error | undefined;
    const stop = (reason: string) => {
      failure ??= new Error(reason);
      try {
        if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGKILL');
        else child.kill('SIGKILL');
      } catch { /* termination is best effort, settlement is not */ }
      cleanup();
      child.stdin.destroy();
      child.stdout.destroy();
      child.stderr.destroy();
      reject(failure);
    };
    const abort = () => stop('Workspace hook aborted');
    context.signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => stop('Workspace hook timed out'), timeoutMs);
    const cleanup = () => { clearTimeout(timer); context.signal?.removeEventListener('abort', abort); };
    const collect = (chunk: Buffer, diagnostic: boolean) => {
      bytes += chunk.length;
      if (bytes > 1024 * 1024) { stop('Workspace hook output exceeded limit'); return; }
      if (diagnostic) stderr += chunk.toString(); else output += chunk.toString();
    };
    child.stdout.on('data', (chunk: Buffer) => collect(chunk, false));
    child.stderr.on('data', (chunk: Buffer) => collect(chunk, true));
    child.stdin.on('error', () => { /* an early exit is handled by close */ });
    child.on('error', error => { cleanup(); reject(error); });
    child.on('close', code => {
      cleanup();
      if (failure) { reject(failure); return; }
      if (code !== 0) { reject(new Error(stderr.trim() || `Workspace hook exited ${code}`)); return; }
      try {
        const value = output.trim();
        // Plain stdout is context/diagnostic output in the SDK contract.
        if (value.startsWith('{')) {
          const result = JSON.parse(value);
          if (result.continue === false || result.decision === 'block'
            || result.hookSpecificOutput?.permissionDecision === 'deny') {
            reject(new Error(result.hookSpecificOutput?.permissionDecisionReason
              || result.reason || result.stopReason || result.systemMessage || 'Workspace hook denied this action'));
            return;
          }
          if (result.hookSpecificOutput?.permissionDecision
            && result.hookSpecificOutput.permissionDecision !== 'allow') {
            reject(new Error('Workspace hook requires an unsupported permission decision'));
            return;
          }
          if (result.hookSpecificOutput?.updatedInput !== undefined) {
            reject(new Error('Workspace hook input rewriting is not supported by Pi'));
            return;
          }
        }
        resolve();
      } catch { reject(new Error('Invalid workspace hook JSON output')); }
    });
    child.stdin.end(payload);
  });
}
