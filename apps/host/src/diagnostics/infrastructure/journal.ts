import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { RequestType } from '@muxr/contract';
import { atomicWriteJson } from '../../platform/atomicWriteJson.js';

const RETENTION_MS = 7 * 24 * 60 * 60_000;
const MAX_EVENTS = 512;
const MAX_BYTES = 256 * 1024;
const RECENT_CLIENT_MS = 15 * 60_000;

export type DiagnosticClientKind = 'local' | 'native' | 'browser' | 'peer' | 'unknown';
export type DiagnosticOutcome = 'ok' | 'rejected' | 'timeout' | 'unavailable';
export type DiagnosticRelayState = 'connecting' | 'open' | 'closed' | 'replaced';
export type DiagnosticBrokerOperation = 'list' | 'read' | 'status' | 'watch' | 'prompt';
export type DiagnosticPeerConnectionPhase = 'grant-refresh' | 'ticket-issue' | 'socket-open' | 'liveness-proof';
export type DiagnosticPeerIngressOutcome = 'received' | 'decrypt-rejected' | 'decoded';
export type DiagnosticRealtimePromptOutcome = 'queued' | 'rejected' | 'failed';
export type DiagnosticReadinessGate = 'ready' | 'starting' | 'not-interactive' | 'unbound' | 'no-agent';


type ClientCounts = Record<DiagnosticClientKind, number>;
type RelationshipCounts = Record<'pending' | 'connected' | 'repair-needed' | 'disconnecting' | 'revoked', number>;

export type HostDiagnosticEvent =
    | { at: string; event: 'host.started'; hostVersion: string }
    | { at: string; event: 'host.stopping' }
    | { at: string; event: 'relay.state'; state: DiagnosticRelayState }
    | { at: string; event: 'client.hello'; clientKind: DiagnosticClientKind; recentClients: ClientCounts }
    | { at: string; event: 'client.request'; clientKind: DiagnosticClientKind; request: RequestType; outcome: DiagnosticOutcome; durationMs: number; code?: string }
    | { at: string; event: 'peer.connection'; direction: 'outbound'; phase: DiagnosticPeerConnectionPhase; outcome: DiagnosticOutcome; durationMs: number; code?: string }
    | { at: string; event: 'peer.ingress'; direction: 'inbound'; outcome: DiagnosticPeerIngressOutcome }
    | { at: string; event: 'peer.broker'; operation: DiagnosticBrokerOperation; outcome: DiagnosticOutcome; durationMs: number; code?: string }
    | { at: string; event: 'realtime.prompt'; provider: string; action: 'prompt'; requestedAgentName: string; resolvedAgentName: string | null; outcome: DiagnosticRealtimePromptOutcome }
    | { at: string; event: 'agent.readiness'; reason: 'starting' | 'ready' | 'not-promptable'; promptable: boolean; kind?: string; lifecycle?: string; gate?: DiagnosticReadinessGate };

interface HostDiagnosticState {
    version: 1;
    current: {
        hostVersion: string;
        startedAt: string;
        updatedAt: string;
        relayState: DiagnosticRelayState;
        recentClientWindowMinutes: 15;
        recentClients: ClientCounts;
        relationships: RelationshipCounts;
    };
    events: HostDiagnosticEvent[];
}

const clientCounts = (): ClientCounts => ({ local: 0, native: 0, browser: 0, peer: 0, unknown: 0 });
const relationshipCounts = (): RelationshipCounts => ({ pending: 0, connected: 0, 'repair-needed': 0, disconnecting: 0, revoked: 0 });
const safeCodes = new Set([
    'host-contract-mismatch', 'e2ee-required', 'peer-forbidden', 'peer-limit',
    'peer-already-authorized', 'peer-mutation-invalid', 'peer-mutation-required',
    'peer-mutation-unresolved', 'peer-recovery-pending', 'peer-operation-uncertain',
    'grant-refresh-failed', 'ticket-issue-failed', 'socket-error', 'socket-closed',
    'socket-timeout', 'liveness-closed', 'liveness-timeout',
    'ticket-required', 'ticket-invalid', 'local-identity-invalid',
    'device-revoked', 'ticket-scope-mismatch', 'preview-bridge-required',
    'agent-not-ready', 'timeout', 'unavailable',
    'not-connected', 'connection-lost', 'client-closed', 'request-timeout',
    'dead-socket', 'stale', 'disconnected', 'takeover',
    'start-launch-failed',
]);
const loggedRequests = new Set<RequestType>([
    'machines.list', 'herdr.tree', 'terminal.attach', 'terminal.detach',
    'session.list', 'session.start', 'session.open', 'session.prompt', 'session.status', 'agent.watch',
    'peer.prepare', 'peer.authorize', 'peer.install', 'peer.list', 'peer.revoke',
    'peer.remote.list', 'peer.remote.read', 'peer.remote.status', 'peer.remote.watch', 'peer.remote.prompt', 'peer.remote.start',
]);

function safeAgentKind(value: string | undefined): string | undefined {
    if (value === undefined) return undefined;
    const kind = value.normalize('NFKC').trim().toLowerCase();
    if (kind === 'shell' || !/^[a-z][a-z0-9._-]{0,31}$/.test(kind)) return undefined;
    return kind;
}

function safeLifecycle(value: string | undefined): string | undefined {
    if (value === 'idle' || value === 'working' || value === 'blocked' || value === 'done'
        || value === 'failed' || value === 'starting' || value === 'unknown') {
        return value;
    }
    return undefined;
}

function safeReadinessGate(value: string | undefined): DiagnosticReadinessGate | undefined {
    if (value === 'ready' || value === 'starting' || value === 'not-interactive' || value === 'unbound' || value === 'no-agent') {
        return value;
    }
    return undefined;
}

function safeCode(value: string | undefined): string | undefined {
    if (value === undefined) return undefined;
    if (safeCodes.has(value)) return value;
    return 'rejected';
}

function safeSemanticName(value: string | null, fallback: string): string | null {
    if (value === null) return null;
    const clean = value
        .normalize('NFKC')
        .replace(/\b(Bearer)\s+[A-Za-z0-9._~+/-]{12,}/gi, '$1 [redacted]')
        .replace(/\b(?:[A-Za-z][A-Za-z0-9]*_)+(?:api_key|token|secret|password)\s*[:=]\s*[^\s,;]+/gi, '[credential redacted]')
        .replace(/\b(api[_-]?key|token|secret|password)\s*[:=]\s*[^\s,;]+/gi, '$1=[redacted]')
        .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/gi, '[credential redacted]')
        .replace(/\beyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/gi, '[credential redacted]')
        .replace(/\b(?:pph?_[a-z0-9]+|w[0-9A-Za-z]+:(?:p|t)[0-9A-Za-z]+|(?:machine|device|session|pane|rel|peer)[-_][a-z0-9_-]{6,})\b/gi, '[internal reference]')
        .replace(/(?<![A-Za-z0-9_/])\/(?!\/)(?:[^\s\/<>"']+\/)+[^\s\/<>"']+/gm, '[path hidden]')
        .replace(/\b[A-Za-z]:\\(?:[^\s\\]+\\)+[^\s,;]*/g, '[path hidden]')
        .replace(/[\u0000-\u001F\u007F<>`{}\\/]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 160);
    return clean || fallback;
}

function validState(value: unknown): value is HostDiagnosticState {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
    const state = value as Partial<HostDiagnosticState>;
    return state.version === 1 && typeof state.current === 'object' && state.current !== null
        && typeof state.current.hostVersion === 'string' && typeof state.current.startedAt === 'string'
        && typeof state.current.updatedAt === 'string' && Array.isArray(state.events)
        && state.events.length <= MAX_EVENTS && Buffer.byteLength(JSON.stringify(value)) <= MAX_BYTES;
}

export class HostDiagnosticsJournal {
    private readonly filePath: string;
    private readonly clientSeen = new Map<string, { kind: DiagnosticClientKind; at: number }>();
    private state: HostDiagnosticState;
    private writes = Promise.resolve();

    constructor(dataDir: string, hostVersion: string, private readonly now: () => number = Date.now) {
        this.filePath = join(dataDir, 'diagnostics.json');
        mkdirSync(dirname(this.filePath), { recursive: true, mode: 0o700 });
        chmodSync(dirname(this.filePath), 0o700);
        const startedAt = this.timestamp();
        this.state = {
            version: 1,
            current: {
                hostVersion,
                startedAt,
                updatedAt: startedAt,
                relayState: 'connecting',
                recentClientWindowMinutes: 15,
                recentClients: clientCounts(),
                relationships: relationshipCounts(),
            },
            events: [],
        };
        if (existsSync(this.filePath)) {
            const info = lstatSync(this.filePath);
            if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077) !== 0) {
                throw new Error(`${this.filePath} must be a regular owner-only file`);
            }
            try {
                const parsed = JSON.parse(readFileSync(this.filePath, 'utf8')) as unknown;
                if (validState(parsed)) this.state.events = parsed.events;
            } catch {
                // Diagnostics are disposable support data, never runtime authority.
                // A partial write resets the journal instead of disabling the host.
            }
        }
        this.record({ at: startedAt, event: 'host.started', hostVersion });
    }

    relay(state: DiagnosticRelayState): void {
        this.state.current.relayState = state;
        this.record({ at: this.timestamp(), event: 'relay.state', state });
    }

    client(clientKey: string, clientKind: DiagnosticClientKind, hello = false): void {
        const now = this.now();
        this.clientSeen.set(clientKey, { kind: clientKind, at: now });
        const counts = this.refreshClientCounts(now);
        if (hello) this.record({ at: this.timestamp(), event: 'client.hello', clientKind, recentClients: counts });
    }

    request(request: RequestType, clientKind: DiagnosticClientKind, outcome: DiagnosticOutcome, durationMs: number, code?: string): void {
        if (!loggedRequests.has(request) || request === 'herdr.tree' && outcome === 'ok') return;
        const normalizedCode = safeCode(code);
        this.record({
            at: this.timestamp(), event: 'client.request', clientKind, request, outcome,
            durationMs: Math.max(0, Math.min(Math.round(durationMs), 10 * 60_000)),
            ...(normalizedCode === undefined ? {} : { code: normalizedCode }),
        });
    }

    peerConnection(phase: DiagnosticPeerConnectionPhase, outcome: DiagnosticOutcome, durationMs: number, code?: string): void {
        const normalizedCode = safeCode(code);
        this.record({
            at: this.timestamp(), event: 'peer.connection', direction: 'outbound', phase, outcome,
            durationMs: Math.max(0, Math.min(Math.round(durationMs), 10 * 60_000)),
            ...(normalizedCode === undefined ? {} : { code: normalizedCode }),
        });
    }

    peerIngress(outcome: DiagnosticPeerIngressOutcome): void {
        this.record({ at: this.timestamp(), event: 'peer.ingress', direction: 'inbound', outcome });
    }

    broker(operation: DiagnosticBrokerOperation, outcome: DiagnosticOutcome, durationMs: number, code?: string): void {
        const normalizedCode = safeCode(code);
        this.record({
            at: this.timestamp(), event: 'peer.broker', operation, outcome,
            durationMs: Math.max(0, Math.min(Math.round(durationMs), 10 * 60_000)),
            ...(normalizedCode === undefined ? {} : { code: normalizedCode }),
        });
    }

    realtimePrompt(
        provider: string,
        requestedAgentName: string,
        resolvedAgentName: string | null,
        outcome: DiagnosticRealtimePromptOutcome,
    ): void {
        this.record({
            at: this.timestamp(),
            event: 'realtime.prompt',
            provider: /^[a-z0-9.-]{1,80}$/.test(provider) ? provider : 'unknown',
            action: 'prompt',
            requestedAgentName: safeSemanticName(requestedAgentName, 'unspecified')!,
            resolvedAgentName: safeSemanticName(resolvedAgentName, 'unknown'),
            outcome,
        });
    }

    agentReadiness(
        reason: 'starting' | 'ready' | 'not-promptable',
        promptable: boolean,
        detail?: { kind?: string; lifecycle?: string; gate?: DiagnosticReadinessGate },
    ): void {
        const kind = safeAgentKind(detail?.kind);
        const lifecycle = safeLifecycle(detail?.lifecycle);
        const gate = safeReadinessGate(detail?.gate);
        this.record({
            at: this.timestamp(),
            event: 'agent.readiness',
            reason,
            promptable,
            ...(kind === undefined ? {} : { kind }),
            ...(lifecycle === undefined ? {} : { lifecycle }),
            ...(gate === undefined ? {} : { gate }),
        });
    }

    relationships(peers: Array<{ state: keyof RelationshipCounts }>): void {
        const counts = relationshipCounts();
        for (const peer of peers) counts[peer.state] += 1;
        this.state.current.relationships = counts;
        const now = this.now();
        this.refreshClientCounts(now);
        this.state.current.updatedAt = new Date(now).toISOString();
        this.persist();
    }

    stopping(): void {
        this.record({ at: this.timestamp(), event: 'host.stopping' });
    }

    flush(): Promise<void> {
        return this.writes;
    }

    private timestamp(): string {
        return new Date(this.now()).toISOString();
    }

    private refreshClientCounts(now: number): ClientCounts {
        for (const [key, seen] of this.clientSeen) if (now - seen.at > RECENT_CLIENT_MS) this.clientSeen.delete(key);
        const counts = clientCounts();
        for (const seen of this.clientSeen.values()) counts[seen.kind] += 1;
        this.state.current.recentClients = counts;
        return counts;
    }

    private record(event: HostDiagnosticEvent): void {
        const now = this.now();
        this.refreshClientCounts(now);
        const cutoff = now - RETENTION_MS;
        this.state.events = [...this.state.events.filter((entry) => Date.parse(entry.at) >= cutoff), event].slice(-MAX_EVENTS);
        this.state.current.updatedAt = event.at;
        while (this.state.events.length > 0 && Buffer.byteLength(JSON.stringify(this.state)) > MAX_BYTES) this.state.events.shift();
        this.persist();
    }

    private persist(): void {
        const snapshot = structuredClone(this.state);
        const run = this.writes.then(async () => {
            await atomicWriteJson(this.filePath, snapshot);
            chmodSync(this.filePath, 0o600);
        });
        this.writes = run.then(() => undefined, () => undefined);
    }
}
