import type { SessionStatus } from '@muxr/contract';
import type { SessionSource } from './sessionSource.js';

export type ReadAgentSessionCommand =
    | { view: 'status'; sessionId: string }
    | { view: 'pane'; sessionId: string; lines?: number; source?: 'visible' | 'recent' | 'recent_unwrapped'; ansi?: boolean }
    | { view: 'file'; sessionId: string; path: string };

export type ReadAgentSessionResult =
    | { ok: true; data: SessionStatus | { text: string; truncated: boolean } | { content: string } }
    | { ok: false; error: string };

export async function readAgentSession(
    sessions: Pick<SessionSource, 'status' | 'paneRead' | 'readFile'>,
    command: ReadAgentSessionCommand,
): Promise<ReadAgentSessionResult> {
    if (command.view === 'status') return { ok: true, data: await sessions.status(command.sessionId) };
    if (command.view === 'file') return { ok: true, data: await sessions.readFile({ sessionId: command.sessionId, path: command.path }) };
    return {
        ok: true,
        data: await sessions.paneRead({
            sessionId: command.sessionId,
            ...(command.lines === undefined ? {} : { lines: command.lines }),
            ...(command.source === undefined ? {} : { source: command.source }),
            ...(command.ansi === undefined ? {} : { ansi: command.ansi }),
        }),
    };
}
