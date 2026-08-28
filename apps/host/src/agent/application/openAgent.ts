import type { SessionSnapshot } from '@muxr/contract';
import type { SessionOpenOptions, SessionSource } from './sessionSource.js';

export type OpenAgentCommand = SessionOpenOptions;

export type OpenAgentResult =
    | { ok: true; data: SessionSnapshot }
    | { ok: false; error: string; code?: string };

export async function openAgent(
    sessions: Pick<SessionSource, 'open'>,
    command: OpenAgentCommand,
): Promise<OpenAgentResult> {
    return { ok: true, data: await sessions.open(command) };
}
