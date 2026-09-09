import { homedir } from 'node:os';
import { MISSING_CWD_ERROR_PREFIX, startWasAccepted, type SessionStartResult } from '@muxr/contract';
import type { SessionStartOptions } from './sessionSource.js';

/** Clients that never learned the machine's home directory send a literal `~`. */
export function expandHome(cwd: string, home = homedir()): string {
    if (cwd === '~') return home;
    if (cwd.startsWith('~/')) return `${home}/${cwd.slice(2)}`;
    return cwd;
}

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
    const cwd = expandHome(command.cwd);
    if (!workspace.exists(cwd)) {
        if (command.createCwd !== true) {
            return { ok: false, error: `${MISSING_CWD_ERROR_PREFIX}${cwd}` };
        }
        await workspace.create(cwd);
    }
    const data = await workspace.start({ ...command, cwd });
    if (!startWasAccepted(data)) {
        return { ok: false, error: data.acceptance.message, code: data.acceptance.code };
    }
    return { ok: true, data };
}
