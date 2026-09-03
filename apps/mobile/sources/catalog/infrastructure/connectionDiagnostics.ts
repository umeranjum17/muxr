/**
 * Phone-side transport and terminal-channel trail.
 *
 * Host `diagnostics.json` only sees frames that crossed the relay. The header
 * can say connected while `herdr.tree` / `terminal.attach` never leave the
 * device; those misses live here. Codes, durations, and counts only —
 * no machine, session, channel, ticket, terminal text, payload bytes, or keys.
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
    | 'socket-error'
    | 'socket-timeout'
    | 'ticket-invalid'
    | 'device-revoked'
    | 'ticket-issue-failed'
    | 'start-launch-failed';
export type ConnectionDiagnosticSocketState = 'connecting' | 'open' | 'stale' | 'closed';
export type ConnectionDiagnosticReconnectReason = 'dead-socket' | 'stale' | 'closed';
export type ConnectionDiagnosticChannelPhase = 'attach' | 'socket-open' | 'live' | 'reconnecting' | 'disconnected';
export type ConnectionDiagnosticGate = 'ready' | 'starting' | 'not-interactive' | 'unbound' | 'missing';
export type ConnectionDiagnosticLifecycle = 'idle' | 'working' | 'blocked' | 'done' | 'failed' | 'starting' | 'unknown';
export type ConnectionDiagnosticSocketFailureStage = 'grant' | 'ticket' | 'dial' | 'close' | 'decode' | 'liveness';
export type ConnectionDiagnosticSocketFailureCode =
    | 'grant-missing'
    | 'grant-expired'
    | 'grant-refresh-failed'
    | 'ticket-unauthorized'
    | 'ticket-forbidden'
    | 'ticket-not-found'
    | 'ticket-unavailable'
    | 'ticket-network'
    | 'ticket-timeout'
    | 'dial-network'
    | 'dial-timeout'
    | 'socket-closed'
    | 'machine-mismatch'
    | 'context-mismatch'
    | 'open-failed'
    | 'no-host-frame'
    | 'all-frames-rejected';
export type ConnectionDiagnosticSocketCloseReason =
    | 'normal'
    | 'going-away'
    | 'protocol-error'
    | 'unsupported-data'
    | 'abnormal'
    | 'invalid-data'
    | 'policy'
    | 'message-too-large'
    | 'extension-required'
    | 'internal-error'
    | 'service-restart'
    | 'try-again'
    | 'replaced'
    | 'private'
    | 'other';

export type ConnectionDiagnosticEvent =
    | { at: string; event: 'socket.state'; state: ConnectionDiagnosticSocketState; live: boolean }
    | { at: string; event: 'socket.reconnect'; reason: ConnectionDiagnosticReconnectReason }
    | {
        at: string;
        event: 'socket.fail';
        stage: ConnectionDiagnosticSocketFailureStage;
        code: ConnectionDiagnosticSocketFailureCode;
        closeCode?: number;
        closeReason?: ConnectionDiagnosticSocketCloseReason;
    }
    | { at: string; event: 'rpc'; request: ConnectionDiagnosticRequest; outcome: ConnectionDiagnosticOutcome; durationMs: number; code?: ConnectionDiagnosticCode }
    | { at: string; event: 'terminal.channel'; phase: ConnectionDiagnosticChannelPhase; outcome: ConnectionDiagnosticOutcome; code?: ConnectionDiagnosticCode }
    | { at: string; event: 'agent.gate'; kind?: string; lifecycle: ConnectionDiagnosticLifecycle; promptable: boolean; gate: ConnectionDiagnosticGate }
    | { at: string; event: 'terminal.first-frame'; ms: number }
    | { at: string; event: 'terminal.frames'; received: number; written: number };

declare const terminalFrameCountBrand: unique symbol;
export type TerminalFrameCountToken = { readonly [terminalFrameCountBrand]?: never };

const MAX_EVENTS = 64;
const MAX_FRAME_COUNT = 1_000_000;
const STORAGE_KEY = 'connection-diagnostics-v1';
const PRIVACY_HEADER = 'Redacted: durations, counts, and enums only. No ids, URLs, IPs, bytes, content, tickets, or keys.';
const TRACKED = new Set<string>(['herdr.tree', 'terminal.attach', 'terminal.detach', 'session.prompt', 'session.start']);
const SOCKET_STATES = new Set<string>(['connecting', 'open', 'stale', 'closed']);
const RECONNECT_REASONS = new Set<string>(['dead-socket', 'stale', 'closed']);
const CHANNEL_PHASES = new Set<string>(['attach', 'socket-open', 'live', 'reconnecting', 'disconnected']);
const GATES = new Set<string>(['ready', 'starting', 'not-interactive', 'unbound', 'missing']);
const LIFECYCLES = new Set<string>(['idle', 'working', 'blocked', 'done', 'failed', 'starting', 'unknown']);
const OUTCOMES = new Set<string>(['ok', 'rejected', 'timeout', 'unavailable']);
const SOCKET_FAILURE_STAGES: Record<string, true> = {
    grant: true, ticket: true, dial: true, close: true, decode: true, liveness: true,
};
const SOCKET_FAILURE_CODES: Record<string, true> = {
    'grant-missing': true,
    'grant-expired': true,
    'grant-refresh-failed': true,
    'ticket-unauthorized': true,
    'ticket-forbidden': true,
    'ticket-not-found': true,
    'ticket-unavailable': true,
    'ticket-network': true,
    'ticket-timeout': true,
    'dial-network': true,
    'dial-timeout': true,
    'socket-closed': true,
    'machine-mismatch': true,
    'context-mismatch': true,
    'open-failed': true,
    'no-host-frame': true,
    'all-frames-rejected': true,
};
const SOCKET_CLOSE_REASONS: Record<string, true> = {
    normal: true,
    'going-away': true,
    'protocol-error': true,
    'unsupported-data': true,
    abnormal: true,
    'invalid-data': true,
    policy: true,
    'message-too-large': true,
    'extension-required': true,
    'internal-error': true,
    'service-restart': true,
    'try-again': true,
    replaced: true,
    private: true,
    other: true,
};
const CODES: Record<string, true> = {
    'not-connected': true,
    'connection-lost': true,
    'client-closed': true,
    'request-timeout': true,
    'ticket-required': true,
    'grant-expired': true,
    'e2ee-required': true,
    'agent-not-ready': true,
    'dead-socket': true,
    stale: true,
    takeover: true,
    disconnected: true,
    unavailable: true,
    'socket-error': true,
    'socket-timeout': true,
    'ticket-invalid': true,
    'device-revoked': true,
    'ticket-issue-failed': true,
    'start-launch-failed': true,
};

let events: ConnectionDiagnosticEvent[] = loadPersisted();
const frameCounts = new WeakMap<TerminalFrameCountToken, { received: number; written: number; open: boolean }>();
const liveFrameCounts = new Set<TerminalFrameCountToken>();

export function resetConnectionDiagnostics(): void {
    events = [];
    for (const token of liveFrameCounts) {
        const state = frameCounts.get(token);
        if (state !== undefined) state.open = false;
    }
    liveFrameCounts.clear();
    persist(events);
}

export function readConnectionDiagnostics(): readonly ConnectionDiagnosticEvent[] {
    return events;
}

export function isTrackedConnectionRequest(type: string): type is ConnectionDiagnosticRequest {
    return TRACKED.has(type);
}

export function connectionDiagnosticCode(error: unknown): ConnectionDiagnosticCode | undefined {
    if (typeof error === 'string' && CODES[error] === true) return error as ConnectionDiagnosticCode;
    const code = error instanceof Error && 'code' in error && typeof (error as { code?: unknown }).code === 'string'
        ? (error as { code: string }).code
        : undefined;
    if (typeof code === 'string' && CODES[code] === true) return code as ConnectionDiagnosticCode;
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
    if (code === 'request-timeout' || code === 'socket-timeout') return 'timeout';
    if (code === 'not-connected' || code === 'connection-lost' || code === 'client-closed' || code === 'dead-socket' || code === 'stale'
        || code === 'disconnected' || code === 'unavailable' || code === 'socket-error') {
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

export function recordSocketFailure(input: {
    stage: ConnectionDiagnosticSocketFailureStage;
    code: ConnectionDiagnosticSocketFailureCode;
    closeCode?: number;
    closeReason?: ConnectionDiagnosticSocketCloseReason;
}): void {
    const closeCode = boundedCloseCode(input.closeCode);
    recordConnectionDiagnostic({
        event: 'socket.fail',
        stage: input.stage,
        code: input.code,
        ...(closeCode === undefined ? {} : { closeCode }),
        ...(input.closeReason === undefined ? {} : { closeReason: input.closeReason }),
    });
}

export function ticketFailureCode(status: number): ConnectionDiagnosticSocketFailureCode {
    if (status === 401) return 'ticket-unauthorized';
    if (status === 403) return 'ticket-forbidden';
    if (status === 404) return 'ticket-not-found';
    return 'ticket-unavailable';
}

export function socketCloseReason(code: number): ConnectionDiagnosticSocketCloseReason {
    if (code === 1000) return 'normal';
    if (code === 1001) return 'going-away';
    if (code === 1002) return 'protocol-error';
    if (code === 1003) return 'unsupported-data';
    if (code === 1006) return 'abnormal';
    if (code === 1007) return 'invalid-data';
    if (code === 1008) return 'policy';
    if (code === 1009) return 'message-too-large';
    if (code === 1010) return 'extension-required';
    if (code === 1011) return 'internal-error';
    if (code === 1012) return 'service-restart';
    if (code === 1013) return 'try-again';
    if (code === 4000) return 'replaced';
    if (code >= 4000 && code <= 4999) return 'private';
    return 'other';
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

export function beginTerminalFrameCounts(): TerminalFrameCountToken {
    const token: TerminalFrameCountToken = {};
    frameCounts.set(token, { received: 0, written: 0, open: true });
    liveFrameCounts.add(token);
    return token;
}

export function recordTerminalFrameReceived(token: TerminalFrameCountToken): void {
    const state = frameCounts.get(token);
    if (state === undefined || !state.open) return;
    state.received = boundedCount(state.received + 1);
}

export function recordTerminalFrameWritten(token: TerminalFrameCountToken): void {
    const state = frameCounts.get(token);
    if (state === undefined || !state.open) return;
    state.written = boundedCount(state.written + 1);
}

export function finalizeTerminalFrameCounts(token: TerminalFrameCountToken): void {
    const state = frameCounts.get(token);
    if (state === undefined || !state.open) return;
    state.open = false;
    liveFrameCounts.delete(token);
    recordConnectionDiagnostic({
        event: 'terminal.frames',
        received: state.received,
        written: state.written,
    });
}

export function recordTerminalFirstFrame(ms: number): void {
    recordConnectionDiagnostic({ event: 'terminal.first-frame', ms: boundedDuration(ms) });
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
    const body = events.length === 0
        ? 'No phone transport events yet.'
        : events.map((event) => `${event.at} ${summarize(event)}`).join('\n');
    const live = liveFrameLine();
    return live === undefined ? `${PRIVACY_HEADER}\n${body}` : `${PRIVACY_HEADER}\n${body}\n${live}`;
}

export function formatLatestConnectionFailure(): string | undefined {
    const failure = events.findLast((event) => event.event === 'socket.fail');
    if (failure === undefined || failure.event !== 'socket.fail') return undefined;
    if (failure.stage === 'liveness') {
        return failure.code === 'no-host-frame'
            ? 'Relay connected; machine has not answered in 20 s.'
            : 'Relay connected; every machine frame was rejected for 20 s.';
    }
    const close = failure.closeCode === undefined
        ? ''
        : ` · ${failure.closeCode} ${failure.closeReason ?? 'other'}`;
    return `Latest failure: ${failure.stage} · ${failure.code}${close}`;
}

function liveFrameLine(): string | undefined {
    if (liveFrameCounts.size === 0) return undefined;
    let received = 0;
    let written = 0;
    for (const token of liveFrameCounts) {
        const state = frameCounts.get(token);
        if (state === undefined || !state.open) continue;
        received = boundedCount(received + state.received);
        written = boundedCount(written + state.written);
    }
    return `terminal.frames live received=${received} written=${written}`;
}

function summarize(event: ConnectionDiagnosticEvent): string {
    if (event.event === 'socket.state') return `socket.state ${event.state} live=${String(event.live)}`;
    if (event.event === 'socket.reconnect') return `socket.reconnect ${event.reason}`;
    if (event.event === 'socket.fail') {
        const close = event.closeCode === undefined ? '' : ` ${event.closeCode} ${event.closeReason ?? 'unknown'}`;
        return `socket.fail ${event.stage} ${event.code}${close}`;
    }
    if (event.event === 'rpc') {
        const code = event.code === undefined ? '' : ` ${event.code}`;
        return `rpc ${event.request} ${event.outcome}${code} ${event.durationMs}ms`;
    }
    if (event.event === 'agent.gate') {
        const kind = event.kind === undefined ? '' : ` ${event.kind}`;
        return `agent.gate${kind} ${event.lifecycle} promptable=${String(event.promptable)} ${event.gate}`;
    }
    if (event.event === 'terminal.first-frame') return `terminal.first-frame ${event.ms}ms`;
    if (event.event === 'terminal.frames') return `terminal.frames received=${event.received} written=${event.written}`;
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

function boundedCount(value: number): number {
    if (!Number.isFinite(value)) return 0;
    return Math.max(0, Math.min(Math.round(value), MAX_FRAME_COUNT));
}

function boundedCloseCode(value: number | undefined): number | undefined {
    if (value === undefined || !Number.isInteger(value) || value < 1000 || value > 4999) return undefined;
    return value;
}

function isIsoTime(value: unknown): value is string {
    return typeof value === 'string' && Number.isFinite(Date.parse(value)) && value.length <= 40;
}

function isFiniteCount(value: unknown): value is number {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= MAX_FRAME_COUNT;
}

function isValidEvent(value: unknown): value is ConnectionDiagnosticEvent {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
    const event = value as Record<string, unknown>;
    if (!isIsoTime(event.at)) return false;
    if (event.event === 'socket.state') {
        return SOCKET_STATES.has(String(event.state)) && typeof event.live === 'boolean';
    }
    if (event.event === 'socket.reconnect') return RECONNECT_REASONS.has(String(event.reason));
    if (event.event === 'socket.fail') {
        return SOCKET_FAILURE_STAGES[String(event.stage)] === true
            && SOCKET_FAILURE_CODES[String(event.code)] === true
            && (event.closeCode === undefined || boundedCloseCode(event.closeCode as number) !== undefined)
            && (event.closeReason === undefined || SOCKET_CLOSE_REASONS[String(event.closeReason)] === true);
    }
    if (event.event === 'rpc') {
        return TRACKED.has(String(event.request))
            && OUTCOMES.has(String(event.outcome))
            && typeof event.durationMs === 'number'
            && Number.isFinite(event.durationMs)
            && (event.code === undefined || CODES[String(event.code)] === true);
    }
    if (event.event === 'terminal.channel') {
        return CHANNEL_PHASES.has(String(event.phase))
            && OUTCOMES.has(String(event.outcome))
            && (event.code === undefined || CODES[String(event.code)] === true);
    }
    if (event.event === 'agent.gate') {
        return LIFECYCLES.has(String(event.lifecycle))
            && GATES.has(String(event.gate))
            && typeof event.promptable === 'boolean'
            && (event.kind === undefined || typeof event.kind === 'string' && /^[a-z][a-z0-9._-]{0,31}$/.test(event.kind));
    }
    if (event.event === 'terminal.first-frame') return isFiniteCount(event.ms);
    if (event.event === 'terminal.frames') return isFiniteCount(event.received) && isFiniteCount(event.written);
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
