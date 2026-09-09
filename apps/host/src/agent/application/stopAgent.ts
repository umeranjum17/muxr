import { parseCloseScope, parsePublicAgentRoute, type CloseResult, type CloseScope } from '@muxr/contract';
import type { SessionSource } from './sessionSource.js';

export type StopAgentCommand =
    | {
          sessionId: string;
          action: 'stop';
          deviceId: string;
          idempotencyKey: string;
          confirmedScope?: CloseScope;
      }
    | { sessionId: string; action: 'abort' | 'reload' };

export type StopAgentResult =
    | { ok: true; data: CloseResult | null }
    | { ok: false; error: string; code?: string };

export interface StopAgentPorts {
    sessions: Pick<SessionSource, 'stop' | 'abort' | 'reload'>;
}

export function stopAgent(
    ports: StopAgentPorts,
    command: Extract<StopAgentCommand, { action: 'stop' }>,
): Promise<{ ok: true; data: CloseResult } | { ok: false; error: string; code?: string }>;
export function stopAgent(
    ports: StopAgentPorts,
    command: Extract<StopAgentCommand, { action: 'abort' | 'reload' }>,
): Promise<{ ok: true; data: null } | { ok: false; error: string; code?: string }>;
export async function stopAgent(ports: StopAgentPorts, command: StopAgentCommand): Promise<StopAgentResult> {
    if (command.action === 'stop') {
        const route = parsePublicAgentRoute(command.sessionId);
        if (!route.ok) return { ok: false, error: route.error };
        if (command.confirmedScope !== undefined) {
            const scope = parseCloseScope(command.confirmedScope);
            if (!scope.ok) return { ok: false, error: scope.error };
        }
        return {
            ok: true,
            data: await ports.sessions.stop(
                route.value,
                {
                    deviceId: command.deviceId,
                    idempotencyKey: command.idempotencyKey,
                    ...(command.confirmedScope === undefined ? {} : { confirmedScope: command.confirmedScope }),
                },
            ),
        };
    }
    if (command.action === 'abort') {
        await ports.sessions.abort(command.sessionId);
        return { ok: true, data: null };
    }
    await ports.sessions.reload(command.sessionId);
    return { ok: true, data: null };
}
