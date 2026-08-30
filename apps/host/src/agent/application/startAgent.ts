import { MISSING_CWD_ERROR_PREFIX, startWasAccepted, type SessionStartResult } from '@muxr/contract';
import type { SessionStartOptions } from './sessionSource.js';

export type StartAgentCommand = SessionStartOptions;

export type StartAgentResult =
    | { ok: true; data: SessionStartResult }
    | { ok: false; error: string; code?: string };

export interface StartAgentWorkspace {
    exists(cwd: string): boolean;
    create(cwd: string): Promise<void>;
    start(command: SessionStartOptions): Promise<SessionStartResult>;
}

/**
 * Start an Agent in a workspace directory.
 * Pi journals a session under the cwd slug before it refuses a missing
 * directory; settle the directory first so an orphan is never left behind.
 */
export async function startAgent(
    workspace: StartAgentWorkspace,
    command: StartAgentCommand,
): Promise<StartAgentResult> {
    if (!workspace.exists(command.cwd)) {
        if (command.createCwd !== true) {
            return { ok: false, error: `${MISSING_CWD_ERROR_PREFIX}${command.cwd}` };
        }
        await workspace.create(command.cwd);
    }
    const data = await workspace.start(command);
    if (!startWasAccepted(data)) {
        return { ok: false, error: data.acceptance.message, code: data.acceptance.code };
    }
    return { ok: true, data };
}
