import type { SessionSource } from './sessionSource.js';

export type FocusAgentCommand =
    | { target: 'pane'; sessionId: string }
    | { target: 'pane-neighbor'; sessionId: string; direction: 'left' | 'right' | 'up' | 'down' }
    | { target: 'tab-neighbor'; sessionId: string; direction: 'next' | 'prev' }
    | { target: 'workspace-neighbor'; sessionId: string; direction: 'next' | 'prev' };

export type FocusAgentResult = { ok: true; data: null } | { ok: false; error: string; code?: string };

export async function focusAgent(
    sessions: Pick<SessionSource, 'paneFocus' | 'focusNeighbor' | 'focusTabNeighbor' | 'focusWorkspaceNeighbor'>,
    command: FocusAgentCommand,
): Promise<FocusAgentResult> {
    if (command.target === 'pane') await sessions.paneFocus(command.sessionId);
    else if (command.target === 'pane-neighbor') await sessions.focusNeighbor(command.sessionId, command.direction);
    else if (command.target === 'tab-neighbor') await sessions.focusTabNeighbor(command.sessionId, command.direction);
    else await sessions.focusWorkspaceNeighbor(command.sessionId, command.direction);
    return { ok: true, data: null };
}
