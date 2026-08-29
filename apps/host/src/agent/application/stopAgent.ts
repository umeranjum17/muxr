import type { SessionSource } from './sessionSource.js';

export type StopAgentCommand = {
    sessionId: string;
    action: 'stop' | 'abort' | 'reload';
};

export type StopAgentResult = { ok: true; data: null } | { ok: false; error: string };

export interface StopAgentPorts {
    sessions: Pick<SessionSource, 'stop' | 'abort' | 'reload'>;
}

export async function stopAgent(ports: StopAgentPorts, command: StopAgentCommand): Promise<StopAgentResult> {
    if (command.action === 'stop') {
        await ports.sessions.stop(command.sessionId);
        return { ok: true, data: null };
    }
    if (command.action === 'abort') {
        await ports.sessions.abort(command.sessionId);
        return { ok: true, data: null };
    }
    await ports.sessions.reload(command.sessionId);
    return { ok: true, data: null };
}
