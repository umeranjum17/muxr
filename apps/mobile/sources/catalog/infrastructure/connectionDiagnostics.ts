/**
 * Phone-side transport and terminal-channel trail.
 *
 * Host `diagnostics.json` only sees frames that crossed the relay. The header
 * can say connected while `herdr.tree` / `terminal.attach` never leave the
 * device; those misses live here. Codes only — no machine, session, channel,
 * ticket, or error text.
 */

export type ConnectionDiagnosticRequest = 'herdr.tree' | 'terminal.attach' | 'terminal.detach' | 'session.prompt' | 'session.start';
export type ConnectionDiagnosticOutcome = 'ok' | 'rejected' | 'timeout' | 'unavailable';
export type ConnectionDiagnosticCode =
    | 'not-connected'
    | 'connection-lost'
    | 'client-closed'
    | 'request-timeout'
    | 'ticket-required'
    | 'grant-expired'
    | 'e2ee-required'
    | 'agent-not-ready'
    | 'dead-socket'
    | 'stale'
    | 'takeover'
    | 'disconnected'
    | 'unavailable'
    | 'start-launch-failed';
export type ConnectionDiagnosticSocketState = 'connecting' | 'open' | 'stale' | 'closed';
export type ConnectionDiagnosticReconnectReason = 'dead-socket' | 'stale' | 'closed';
export type ConnectionDiagnosticChannelPhase = 'attach' | 'socket-open' | 'live' | 'reconnecting' | 'disconnected';
export type ConnectionDiagnosticGate = 'ready' | 'starting' | 'not-interactive' | 'unbound' | 'missing';
export type ConnectionDiagnosticLifecycle = 'idle' | 'working' | 'blocked' | 'done' | 'failed' | 'starting' | 'unknown';

export type ConnectionDiagnosticEvent =
    | { at: string; event: 'socket.state'; state: ConnectionDiagnosticSocketState; live: boolean }
    | { at: string; event: 'socket.reconnect'; reason: ConnectionDiagnosticReconnectReason }
    | { at: string; event: 'rpc'; request: ConnectionDiagnosticRequest; outcome: ConnectionDiagnosticOutcome; durationMs: number; code?: ConnectionDiagnosticCode }
    | { at: string; event: 'terminal.channel'; phase: ConnectionDiagnosticChannelPhase; outcome: ConnectionDiagnosticOutcome; code?: ConnectionDiagnosticCode }
    | { at: string; event: 'agent.gate'; kind?: string; lifecycle: ConnectionDiagnosticLifecycle; promptable: boolean; gate: ConnectionDiagnosticGate };

const MAX_EVENTS = 64;
const STORAGE_KEY = 'connection-diagnostics-v1';
const TRACKED = new Set<string>(['herdr.tree', 'terminal.attach', 'terminal.detach', 'session.prompt', 'session.start']);
const SOCKET_STATES = new Set<string>(['connecting', 'open', 'stale', 'closed']);
const RECONNECT_REASONS = new Set<string>(['dead-socket', 'stale', 'closed']);
const CHANNEL_PHASES = new Set<string>(['attach', 'socket-open', 'live', 'reconnecting', 'disconnected']);
const GATES = new Set<string>(['ready', 'starting', 'not-interactive', 'unbound', 'missing']);
const LIFECYCLES = new Set<string>(['idle', 'working', 'blocked', 'done', 'failed', 'starting', 'unknown']);
const OUTCOMES = new Set<string>(['ok', 'rejected', 'timeout', 'unavailable']);
const CODES = new Set<string>([
    'not-connected', 'connection-lost', 'client-closed', 'request-timeout',
    'ticket-required', 'grant-expired', 'e2ee-required', 'agent-not-ready',
    'dead-socket', 'stale', 'takeover', 'disconnected', 'unavailable',
    'start-launch-failed',
]);

let events: ConnectionDiagnosticEvent[] = loadPersisted();

export function resetConnectionDiagnostics(): void {
    events = [];
    persist(events);
}

export function readConnectionDiagnostics(): readonly ConnectionDiagnosticEvent[] {
    return events;
}

export function isTrackedConnectionRequest(type: string): type is ConnectionDiagnosticRequest {
    return TRACKED.has(type);
}

export function connectionDiagnosticCode(error: unknown): ConnectionDiagnosticCode | undefined {
    if (typeof error === 'string' && CODES.has(error)) return error as ConnectionDiagnosticCode;
    const code = error instanceof Error && 'code' in error && typeof (error as { code?: unknown }).code === 'string'
        ? (error as { code: string }).code
        : undefined;
    if (typeof code === 'string' && CODES.has(code)) return code as ConnectionDiagnosticCode;
    const message = error instanceof Error ? error.message : String(error);
    if (/^not connected$/i.test(message)) return 'not-connected';
    if (/^connection lost$/i.test(message)) return 'connection-lost';
    if (/^client closed$/i.test(message)) return 'client-closed';
    if (/^request timed out:/i.test(message)) return 'request-timeout';
    if (/relay ticket required/i.test(message)) return 'ticket-required';
    if (/grant expired/i.test(message)) return 'grant-expired';
    if (/grant is missing/i.test(message)) return 'e2ee-required';
    if (/not ready/i.test(message)) return 'agent-not-ready';
    if (/control moved|takeover required/i.test(message)) return 'takeover';
    if (/relay did not accept/i.test(message)) return 'connection-lost';
    if (/could not start Herdr|no current Herdr pane|not available on this host/i.test(message)) return 'unavailable';
    return undefined;
}

export function connectionDiagnosticOutcome(error: unknown): ConnectionDiagnosticOutcome {
    const code = connectionDiagnosticCode(error);
    if (code === 'request-timeout') return 'timeout';
    if (code === 'not-connected' || code === 'connection-lost' || code === 'client-closed' || code === 'dead-socket' || code === 'stale' || code === 'disconnected' || code === 'unavailable') {
        return 'unavailable';
    }
    return 'rejected';
}

type ConnectionDiagnosticDraft = ConnectionDiagnosticEvent extends infer Event
    ? Event extends { at: string } ? Omit<Event, 'at'> & { at?: string } : never
    : never;

export function recordConnectionDiagnostic(event: ConnectionDiagnosticDraft): void {
    const entry = { at: event.at ?? new Date().toISOString(), ...event } as ConnectionDiagnosticEvent;
    if (!isValidEvent(entry)) return;
    events = [...events, entry].slice(-MAX_EVENTS);
    persist(events);
    if (typeof __DEV__ !== 'undefined' && __DEV__) {
        console.debug('[muxr.diag]', entry.event, summarize(entry));
    }
}

export function recordSocketState(state: string, live: boolean): void {
    if (!SOCKET_STATES.has(state)) return;
    recordConnectionDiagnostic({
        event: 'socket.state',
        state: state as ConnectionDiagnosticSocketState,
        live,
    });
}

export function recordSocketReconnect(state: string, live: boolean): void {
    const reason: ConnectionDiagnosticReconnectReason = state === 'open' && !live
        ? 'dead-socket'
        : state === 'stale' ? 'stale' : 'closed';
    recordConnectionDiagnostic({ event: 'socket.reconnect', reason });
}

export function recordTrackedRpc(
    type: string,
    result: { ok: true } | { ok: false; error: unknown },
    durationMs: number,
): void {
    if (!isTrackedConnectionRequest(type)) return;
    if (result.ok) {
        recordConnectionDiagnostic({ event: 'rpc', request: type, outcome: 'ok', durationMs: boundedDuration(durationMs) });
        return;
    }
    const code = connectionDiagnosticCode(result.error);
    recordConnectionDiagnostic({
        event: 'rpc',
        request: type,
        outcome: connectionDiagnosticOutcome(result.error),
        durationMs: boundedDuration(durationMs),
        ...(code === undefined ? {} : { code }),
    });
}

export function recordAgentGate(input: {
    kind?: string;
    lifecycle?: string;
    promptable: boolean;
    gate: ConnectionDiagnosticGate;
}): void {
    const kind = safeAgentKind(input.kind);
    const lifecycle = LIFECYCLES.has(String(input.lifecycle))
        ? input.lifecycle as ConnectionDiagnosticLifecycle
        : 'unknown';
    const last = events.at(-1);
    if (last?.event === 'agent.gate'
        && last.kind === kind
        && last.lifecycle === lifecycle
        && last.promptable === input.promptable
        && last.gate === input.gate) {
        return;
    }
    recordConnectionDiagnostic({
        event: 'agent.gate',
        ...(kind === undefined ? {} : { kind }),
        lifecycle,
        promptable: input.promptable,
        gate: input.gate,
    });
}

export function recordTerminalChannel(
    phase: ConnectionDiagnosticChannelPhase,
    result: { ok: true } | { ok: false; error?: unknown; code?: ConnectionDiagnosticCode },
): void {
    if (result.ok) {
        recordConnectionDiagnostic({ event: 'terminal.channel', phase, outcome: 'ok' });
        return;
    }
    const code = result.code ?? connectionDiagnosticCode(result.error);
    recordConnectionDiagnostic({
        event: 'terminal.channel',
        phase,
        outcome: result.error === undefined && code === undefined ? 'rejected' : connectionDiagnosticOutcome(result.error ?? code),
        ...(code === undefined ? {} : { code }),
    });
}

export function formatConnectionDiagnosticsForReport(): string {
    if (events.length === 0) return 'No phone transport events yet.';
    return events.map((event) => `${event.at} ${summarize(event)}`).join('\n');
}

function summarize(event: ConnectionDiagnosticEvent): string {
    if (event.event === 'socket.state') return `socket.state ${event.state} live=${String(event.live)}`;
    if (event.event === 'socket.reconnect') return `socket.reconnect ${event.reason}`;
    if (event.event === 'rpc') {
        const code = event.code === undefined ? '' : ` ${event.code}`;
        return `rpc ${event.request} ${event.outcome}${code} ${event.durationMs}ms`;
    }
    if (event.event === 'agent.gate') {
        const kind = event.kind === undefined ? '' : ` ${event.kind}`;
        return `agent.gate${kind} ${event.lifecycle} promptable=${String(event.promptable)} ${event.gate}`;
    }
    const code = event.code === undefined ? '' : ` ${event.code}`;
    return `terminal.channel ${event.phase} ${event.outcome}${code}`;
}

function safeAgentKind(value: string | undefined): string | undefined {
    if (value === undefined) return undefined;
    const kind = value.trim().toLowerCase();
    if (kind === 'shell' || !/^[a-z][a-z0-9._-]{0,31}$/.test(kind)) return undefined;
    return kind;
}

function boundedDuration(durationMs: number): number {
    if (!Number.isFinite(durationMs)) return 0;
    return Math.max(0, Math.min(Math.round(durationMs), 10 * 60_000));
}

function isIsoTime(value: unknown): value is string {
    return typeof value === 'string' && Number.isFinite(Date.parse(value)) && value.length <= 40;
}

function isValidEvent(value: unknown): value is ConnectionDiagnosticEvent {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
    const event = value as Record<string, unknown>;
    if (!isIsoTime(event.at)) return false;
    if (event.event === 'socket.state') {
        return SOCKET_STATES.has(String(event.state)) && typeof event.live === 'boolean';
    }
    if (event.event === 'socket.reconnect') return RECONNECT_REASONS.has(String(event.reason));
    if (event.event === 'rpc') {
        return TRACKED.has(String(event.request))
            && OUTCOMES.has(String(event.outcome))
            && typeof event.durationMs === 'number'
            && Number.isFinite(event.durationMs)
            && (event.code === undefined || CODES.has(String(event.code)));
    }
    if (event.event === 'terminal.channel') {
        return CHANNEL_PHASES.has(String(event.phase))
            && OUTCOMES.has(String(event.outcome))
            && (event.code === undefined || CODES.has(String(event.code)));
    }
    if (event.event === 'agent.gate') {
        return LIFECYCLES.has(String(event.lifecycle))
            && GATES.has(String(event.gate))
            && typeof event.promptable === 'boolean'
            && (event.kind === undefined || typeof event.kind === 'string' && /^[a-z][a-z0-9._-]{0,31}$/.test(event.kind));
    }
    return false;
}

function loadPersisted(): ConnectionDiagnosticEvent[] {
    const raw = readStore();
    if (raw === undefined) return [];
    try {
        const parsed = JSON.parse(raw) as unknown;
        if (!Array.isArray(parsed)) return [];
        return parsed.filter(isValidEvent).slice(-MAX_EVENTS);
    } catch {
        return [];
    }
}

function persist(next: readonly ConnectionDiagnosticEvent[]): void {
    writeStore(JSON.stringify(next));
}

function readStore(): string | undefined {
    try {
        const store = mmkv();
        const raw = store?.getString(STORAGE_KEY);
        return typeof raw === 'string' ? raw : undefined;
    } catch {
        return undefined;
    }
}

function writeStore(value: string): void {
    try {
        mmkv()?.set(STORAGE_KEY, value);
    } catch {
        // Tests and web without MMKV keep the in-memory trail only.
    }
}

function mmkv(): { getString(key: string): string | undefined; set(key: string, value: string): void } | undefined {
    try {
        // Lazy so vitest can record without a native store.
        const { MMKV } = require('react-native-mmkv') as { MMKV: new () => { getString(key: string): string | undefined; set(key: string, value: string): void } };
        return new MMKV();
    } catch {
        return undefined;
    }
}
