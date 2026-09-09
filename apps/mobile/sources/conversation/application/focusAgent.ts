import { lifecycleIsDeskFocus } from '@/watch';

export type FocusAgentCommand = {
    machineId: string;
    deskFocus?: { agentRoute: string; agentStatus?: string };
    remembered?: { machineId: string; agentRoute: string } | null;
    listed: Array<{ agentRoute: string; activeAt: number; updatedAt: number }>;
};

export type FocusAgentResult =
    | { ok: true; machineId: string; agentRoute: string }
    | { ok: false; reason: 'no-agent' };

/** Bind voice to desk focus when that Agent is working or blocked; otherwise the last listed Agent. */
export function focusAgent(command: FocusAgentCommand): FocusAgentResult {
    if (command.deskFocus !== undefined && lifecycleIsDeskFocus(command.deskFocus.agentStatus)) {
        return { ok: true, machineId: command.machineId, agentRoute: command.deskFocus.agentRoute };
    }
    const remembered = command.remembered;
    if (remembered?.machineId === command.machineId
        && command.listed.some((row) => row.agentRoute === remembered.agentRoute)) {
        return { ok: true, machineId: command.machineId, agentRoute: remembered.agentRoute };
    }
    const recent = [...command.listed]
        .sort((left, right) => (right.activeAt || right.updatedAt) - (left.activeAt || left.updatedAt))[0];
    const agentRoute = recent?.agentRoute ?? command.deskFocus?.agentRoute;
    if (agentRoute === undefined) return { ok: false, reason: 'no-agent' };
    return { ok: true, machineId: command.machineId, agentRoute };
}
