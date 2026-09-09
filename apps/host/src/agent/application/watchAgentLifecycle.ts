import type { WatchSettlement } from '@muxr/contract';
import type { SessionSource } from './sessionSource.js';

export type WatchAgentLifecycleCommand = {
    sessionId: string;
    until?: ('idle' | 'done' | 'blocked' | 'unknown')[];
    timeoutMs?: number;
    /** Peer correlated wait never consumes the shared session event bus. */
    correlatedWait?: boolean;
};

export type WatchAgentLifecycleResult =
    | { ok: true; data: { watching: true; settlement?: WatchSettlement } | { watching: boolean } }
    | { ok: false; error: string };

export async function watchAgentLifecycle(
    sessions: Pick<SessionSource, 'agentWatch' | 'agentWait'>,
    command: WatchAgentLifecycleCommand,
): Promise<WatchAgentLifecycleResult> {
    const params = {
        sessionId: command.sessionId,
        ...(command.until === undefined ? {} : { until: command.until }),
        ...(command.timeoutMs === undefined ? {} : { timeoutMs: command.timeoutMs }),
    };
    if (command.correlatedWait === true) {
        const settlement = await sessions.agentWait(params);
        return { ok: true, data: { watching: true, settlement } };
    }
    return { ok: true, data: await sessions.agentWatch(params) };
}
