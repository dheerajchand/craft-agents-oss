import type { SessionToolContext } from '../context.ts';
import type { ToolResult } from '../types.ts';
import { successResponse, errorResponse } from '../response.ts';

export interface SetSessionParentArgs {
  sessionId?: string;
  parentSessionId: string | null;
}

export async function handleSetSessionParent(
  ctx: SessionToolContext,
  args: SetSessionParentArgs,
): Promise<ToolResult> {
  if (!ctx.setSessionParent) {
    return errorResponse('set_session_parent is not available in this context.');
  }
  if (args.parentSessionId !== null &&
      (typeof args.parentSessionId !== 'string' || !args.parentSessionId.trim())) {
    return errorResponse('Supply an existing parent session ID, or null for a root session.');
  }
  try {
    await ctx.setSessionParent(args.sessionId, args.parentSessionId);
    const target = args.sessionId ? `session ${args.sessionId}` : 'current session';
    return successResponse(args.parentSessionId === null
      ? `Moved ${target} to the workspace root.`
      : `Moved ${target} under session ${args.parentSessionId}.`);
  } catch (error) {
    return errorResponse(`Failed to set parent: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}
