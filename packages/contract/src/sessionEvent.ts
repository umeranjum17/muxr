/**
 * THE contract. One event vocabulary, end to end.
 *
 * The machine host emits these. The relay routes them without parsing them.
 * The client renders them. There is no second session vocabulary and no
 * translation layer -- that is the whole architectural point.
 *
 * Herdr emits the vocabulary: session lifecycle (created/updated/error), state
 * (status/activity/attention), and shell outcomes. The terminal
 * stream carries everything else, off this channel entirely.
 */

import type {
    AttentionCatalog,
    SessionActivity,
    SessionInfo,
    SessionStatus,
} from './sessionState.js';

/** Per-session control + state stream. */
export type SessionEventBody =
    // --- shell ------------------------------------------------------------
    | { type: 'shell.start'; command: string; excludeFromContext?: boolean }
    | { type: 'shell.chunk'; chunk: string }
    | {
          type: 'shell.end';
          output?: string;
          exitCode?: number | null;
          cancelled?: boolean;
          truncated?: boolean;
          fullOutputPath?: string;
          isError?: boolean;
      }
    // --- session state ----------------------------------------------------
    | { type: 'status.update'; status: SessionStatus }
    | { type: 'activity.update'; activity: SessionActivity }
    /**
     * Which sessions need the user, whole catalog every time. It is bounded by
     * session count, and a full replace cannot drift out of sync the way an
     * add/remove delta can when a client misses one.
     */
    | { type: 'attention.update'; catalog: AttentionCatalog }
    /** A watch requested via agent.watch reached a settled state (or timed out). */
    | { type: 'watch.settled'; status: string; detail: string; timedOut?: boolean }
    | { type: 'session.error'; message: string }
    /** The pane's agent exited and the host dropped the session; remove the row. */
    | { type: 'session.removed' }
    | { type: 'session.created'; session: SessionInfo }
    /** Live info changed (terminal title, worktree, pane). Carries the full record. */
    | { type: 'session.updated'; session: SessionInfo };

/**
 * Monotonic per-session sequence stamped by the host on the way out.
 * Clients use it to apply buffered events exactly once after a reconnect.
 */
export type SessionEvent = SessionEventBody & { seq: number };

export type SessionEventType = SessionEventBody['type'];

/** Every variant. Used to assert the wire carries the full vocabulary. */
export const SESSION_EVENT_TYPES = [
    'shell.start',
    'shell.chunk',
    'shell.end',
    'status.update',
    'activity.update',
    'attention.update',
    'watch.settled',
    'session.error',
    'session.removed',
    'session.created',
    'session.updated',
] as const satisfies readonly SessionEventType[];
