import type { SessionInfo } from '@muxr/contract';
import type { SessionListOptions, SessionSource } from './sessionSource.js';

export type ListAgentsCommand = SessionListOptions;

export type ListAgentsResult = { ok: true; data: SessionInfo[] } | { ok: false; error: string };

export async function listAgents(
    sessions: Pick<SessionSource, 'list'>,
    command: ListAgentsCommand = {},
): Promise<ListAgentsResult> {
    return { ok: true, data: await sessions.list(command) };
}
