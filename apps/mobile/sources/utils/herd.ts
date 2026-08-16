import type { AgentLifecycle, HerdrTreeWorkspace } from '@muxr/contract';
import type { Session } from '@/sync/storageTypes';

export interface HerdPane {
    id: string;
    name: string;
    status: AgentLifecycle;
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
    working: 1,
    done: 2,
    idle: 3,
    unknown: 4,
};

export const HERD_STATUS_LABELS: Record<AgentLifecycle, string> = {
    working: 'Working',
    blocked: 'Needs you',
    done: 'Done',
    idle: 'Waiting',
    unknown: 'Offline',
};

export function paneStatus(session: Session): AgentLifecycle {
    const raw = session.metadata?.agentStatus;
    if (raw === 'blocked') return raw;
    if (raw === 'idle' || raw === 'working' || raw === 'done') {
        // Live streaming beats a stale lifecycle word: hosts that predate
        // agentStatus inside status.update only move isStreaming (thinking),
        // so a working agent would otherwise show Done in the LIVE row and
        // the herd widget while the session list's dot says working.
        if (raw !== 'working' && session.presence === 'online' && session.thinking === true) return 'working';
        return raw;
    }
    // herdr hasn't classified this pane yet: derive from live session state so
    // this can never disagree with the session list's dot.
    if (session.presence !== 'online') return 'unknown';
    if (session.agentState?.requests != null && Object.keys(session.agentState.requests).length > 0) return 'blocked';
    return session.thinking === true ? 'working' : 'done';
}

function nameOf(session: Session | undefined, fallback: string): string {
    return session?.metadata?.summary?.text.trim() || fallback;
}

/** The same tree panes Spaces renders, enriched only with session display names. */
export function sortHerd(sessions: Session[], workspaces: readonly HerdrTreeWorkspace[]): HerdPane[] {
    const sessionsById = new Map(sessions.map((session) => [session.id, session]));
    return workspaces
        .flatMap((workspace) => workspace.tabs)
        .flatMap((tab) => tab.panes)
        .flatMap((pane) => {
            if (pane.sessionId === undefined) return [];
            const session = sessionsById.get(pane.sessionId);
            const kind = pane.agentKind ?? 'shell';
            return [{
                id: pane.sessionId,
                name: nameOf(session, pane.label ?? pane.agentName ?? (kind === 'shell' ? 'Shell' : 'Agent')),
                status: pane.agentStatus,
                doing: pane.terminalTitle?.trim() ?? '',
            }];
        })
        .sort((left, right) => HERD_ORDER[left.status] - HERD_ORDER[right.status] || left.name.localeCompare(right.name));
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
    const working = panes.filter((pane) => pane.status === 'working');
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
            return `${pane.name} — ${HERD_STATUS_LABELS[pane.status].toLowerCase()}${doing}`;
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
