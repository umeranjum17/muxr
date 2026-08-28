/**
 * Session domain types owned by the machine host.
 *
 * The host computes all of this where the agents actually run. Clients render
 * it and never re-derive it -- re-derivation on the client is what let two
 * session models drift apart in the previous architecture.
 */

import type { SessionInfo, SessionStatus } from './sessionState.js';
import type { AgentLifecycle } from './sessionState.js';

// --- unread -----------------------------------------------------------------

export interface SessionUnreadEntry {
    sessionId: string;
    cwd: string;
    unreadCount: number;
    lastActivityAt: string;
}

export interface UnreadCatalog {
    revision: number;
    entries: SessionUnreadEntry[];
}

// --- snapshots --------------------------------------------------------------

/** herdr has no per-agent transcript to page; the terminal is the transcript. */
export interface MessagePage {
    messages: unknown[];
    /** Cursor for the next older page; absent when at the beginning. */
    before?: number;
    hasMore: boolean;
}

/** Everything a client needs to render a session it just opened. */
export interface SessionSnapshot {
    info: SessionInfo;
    status: SessionStatus;
    page: MessagePage;
    /** Present on start responses; older clients safely ignore it. */
    acceptance?: {
        outcome: 'accepted';
        state: AgentLifecycle;
        displayName: string;
    };
}

export type SessionStartResult = SessionSnapshot | {
    acceptance: {
        outcome: 'failed';
        state: 'failed';
        displayName: string;
        code: 'start-launch-failed';
        message: string;
    };
};

export function startWasAccepted(result: SessionStartResult): result is SessionSnapshot {
    return result.acceptance === undefined || result.acceptance.outcome === 'accepted';
}

// --- machines ---------------------------------------------------------------

export interface MachineInfo {
    machineId: string;
    name?: string;
    online: boolean;
    lastSeenAt?: string;
    hostVersion?: string;
    platform?: string;
}
