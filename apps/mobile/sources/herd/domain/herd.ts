import { lifecycleEventAgentName, type AgentLifecycle, type HerdrTreeWorkspace, type LifecycleEvent } from '@muxr/contract';
import type { Session } from '@/catalog';
import { Agent } from './Agent';
import { agentLabels, HERD_STATUS_LABELS } from './agentPresentation';

export { HERD_STATUS_LABELS } from './agentPresentation';

export interface HerdPane {
    id: string;
    name: string;
    taskTitle: string;
    agentKind?: string;
    status: AgentLifecycle;
    changedAt?: number;
    doing: string;
}

export type HerdNotificationMode = 'connecting' | 'offline' | 'idle' | 'working' | 'attention' | 'finished';

export interface HerdNotificationState {
    mode: HerdNotificationMode;
    count: number;
    name: string;
    /** Friendly display names only; never pane/session ids or terminal text. */
    names: string;
    /** Stable state identity used only to coalesce native updates. */
    eventKey: string;
}

/** Blocked first: it is the only status that needs the user right now. */
export const HERD_ORDER: Record<AgentLifecycle, number> = {
    blocked: 0,
    failed: 1,
    working: 2,
    starting: 3,
    done: 4,
    idle: 5,
    unknown: 6,
};

export function agentFromSession(session: Session): Agent {
    return new Agent({
        route: session.id,
        agentName: session.metadata?.agentName?.trim() || 'Agent',
        taskTitle: session.metadata?.taskTitle?.trim() || 'Current task',
        recordedStatus: session.metadata?.agentStatus,
        online: session.presence === 'online',
        thinking: session.thinking === true,
        permissionRequestCount: Object.keys(session.agentState?.requests ?? {}).length,
    });
}

export function paneStatus(session: Session): AgentLifecycle {
    return agentFromSession(session).lifecycle();
}

export function lifecycleNotificationState(event: LifecycleEvent): HerdNotificationState {
    const name = lifecycleEventAgentName(event);
    return {
        mode: event.state === 'done' ? 'finished' : 'attention',
        count: 1,
        name,
        names: name,
        eventKey: event.eventId,
    };
}

export function lifecycleNotificationCopy(event: LifecycleEvent): string {
    const name = lifecycleEventAgentName(event);
    if (event.state === 'done') return `${name} finished.`;
    if (event.state === 'failed') {
        const startFailure = event.reasonCode === 'start-launch-failed'
            || event.reasonCode === 'start-timeout'
            || event.reasonCode === 'squad-rolled-back'
            || event.reasonCode === 'agent-unavailable';
        return startFailure ? `${name} could not start.` : `${name} failed.`;
    }
    return `${name} needs attention.`;
}

/** The same tree panes Spaces renders, using the shared agent label vocabulary. */
export function herdPanes(sessions: Session[], workspaces: readonly HerdrTreeWorkspace[]): HerdPane[] {
    const sessionsById = new Map(sessions.map((session) => [session.id, session]));
    const routes = new Set<string>();
    return workspaces
        .flatMap((workspace) => workspace.tabs)
        .flatMap((tab) => tab.panes)
        .flatMap((pane) => {
            if (pane.sessionId === undefined || routes.has(pane.sessionId)) return [];
            routes.add(pane.sessionId);
            const session = sessionsById.get(pane.sessionId);
            const labels = agentLabels(pane, session);
            return [{
                id: pane.sessionId,
                name: labels.agentName,
                ...(labels.agentKind === undefined ? {} : { agentKind: labels.agentKind }),
                taskTitle: labels.taskTitle,
                status: pane.agentStatus,
                changedAt: session?.metadata?.lifecycleStateSince ?? session?.updatedAt,
                doing: '',
            }];
        });
}

export function sortHerd(sessions: Session[], workspaces: readonly HerdrTreeWorkspace[]): HerdPane[] {
    return herdPanes(sessions, workspaces)
        .sort((left, right) => HERD_ORDER[left.status] - HERD_ORDER[right.status]
            || (left.status === 'blocked'
                ? (left.changedAt ?? 0) - (right.changedAt ?? 0)
                : (right.changedAt ?? 0) - (left.changedAt ?? 0))
            || left.id.localeCompare(right.id));
}

/** Structured notification state; native never has to parse display prose. */
export function herdNotificationState(
    panes: HerdPane[],
    socketStatus: 'disconnected' | 'connecting' | 'connected' | 'error',
): HerdNotificationState {
    if (socketStatus === 'connecting') {
        return { mode: 'connecting', count: 0, name: '', names: '', eventKey: 'connecting' };
    }
    if (socketStatus !== 'connected') {
        return { mode: 'offline', count: 0, name: '', names: '', eventKey: 'offline' };
    }

    const blocked = panes.filter((pane) => pane.status === 'blocked');
    const working = panes.filter((pane) => pane.status === 'working' || pane.status === 'starting');
    const active = blocked.length > 0 ? blocked : working;
    const top = active[0];
    if (!top) return { mode: 'idle', count: 0, name: '', names: '', eventKey: 'idle' };
    const mode = blocked.length > 0 ? 'attention' : 'working';
    const names = active.map((pane) => pane.name).join(', ');
    const ids = active.map((pane) => encodeURIComponent(pane.id)).sort().join(',');
    return { mode, count: active.length, name: top.name, names, eventKey: `${mode}:${ids}` };
}

/**
 * A compact local-metadata summary for callers that ask the voice agent what
 * the herd is doing. The model turns this into a sentence instead of reading
 * a raw status list aloud.
 */
export function herdDigest(panes: HerdPane[]): string {
    if (panes.length === 0) return 'Nothing is running right now. Tell the user that, in one short sentence.';
    return [
        'Give the user a status update on the herd. One or two short sentences, plain language, panes named the way a person would. Do not read this list out.',
        '',
        ...panes.map((pane) => {
            const doing = pane.doing === '' ? '' : ` (${pane.doing.slice(0, 60)})`;
            return `${pane.name} — ${HERD_STATUS_LABELS[pane.status].toLowerCase()}: ${pane.taskTitle}${doing}`;
        }),
    ].join('\n');
}

/** A completion is a canonical tree transition, never a transcript/timer guess. */
export function completionAlerts(
    panes: HerdPane[],
    previous: Record<string, AgentLifecycle>,
): HerdPane[] {
    return panes.filter((pane) => {
        const before = previous[pane.id];
        return pane.status === 'done' && (before === 'working' || before === 'blocked');
    });
}

/**
 * One step of completion tracking. A disconnected snapshot reads all-unknown;
 * adopting it as the baseline would eat every working→done that spans a
 * reconnect blip, so offline steps keep the last connected baseline and the
 * completion fires once when the fresh tree arrives.
 */
export function completionTransition(
    panes: HerdPane[],
    connected: boolean,
    previous: Record<string, AgentLifecycle> | null,
): { baseline: Record<string, AgentLifecycle> | null; completed: HerdPane[] } {
    if (!connected) return { baseline: previous, completed: [] };
    const baseline = Object.fromEntries(panes.map((pane) => [pane.id, pane.status]));
    return { baseline, completed: previous === null ? [] : completionAlerts(panes, previous) };
}

/** Replace the current lifecycle notification with one grouped completion. */
export function completionNotificationState(completed: readonly HerdPane[]): HerdNotificationState {
    const names = completed.map((pane) => pane.name).join(', ');
    const ids = completed.map((pane) => encodeURIComponent(pane.id)).sort().join(',');
    return {
        mode: 'finished',
        count: completed.length,
        name: completed[0]?.name ?? 'Agent',
        names,
        eventKey: `finished:${ids}`,
    };
}
