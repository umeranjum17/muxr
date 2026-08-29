import { createHash } from 'node:crypto';
import type {
    PeerClientRequest,
    PeerRequestResult,
    SessionInfo,
} from '@muxr/contract';
import { NodePeerClient, type PeerClientTransport, type PeerConnectionDiagnostic } from '../infrastructure/client.js';
import { PeerStore, type StoredPeerRelationship, type StoredSemanticMutation } from '../infrastructure/store.js';

type RemotePeerRequest = Extract<PeerClientRequest, { type: `peer.remote.${string}` }>;
type SemanticRemoteRequest = Extract<RemotePeerRequest, { type: 'peer.remote.watch' | 'peer.remote.prompt' | 'peer.remote.start' }>;

export interface OutboundPeerServiceOptions {
    store: PeerStore;
    now: () => number;
    sourceMachineName: string;
    clientFactory?: (relationship: StoredPeerRelationship) => PeerClientTransport;
    onConnectionDiagnostic?: (event: PeerConnectionDiagnostic) => void;
}

function operationError(message: string, code: string): Error {
    return Object.assign(new Error(message), { code });
}

function name(value: string | undefined, fallback: string): string {
    const cleaned = value?.replace(/[\u0000-\u001F\u007F<>`{}]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120) ?? '';
    return cleaned === '' || /^(?:pph?_[a-z0-9]+|w\d+[A-Za-z]?:[pt]\d+|(?:machine|device|session|pane|rel|peer)[-_][a-z0-9_-]{6,})$/i.test(cleaned)
        ? fallback
        : cleaned;
}

function key(value: string): string {
    return value.toLocaleLowerCase();
}


function currentSessionAgentName(session: SessionInfo): string | undefined {
    if (session.agentName !== undefined) return session.agentName;
    if ('displayName' in session && typeof session.displayName === 'string') return session.displayName;
    return undefined;
}
/** Outbound routing, durable semantic mutations, transport ownership, and stable user-facing selectors. */
export class OutboundPeerService {
    private readonly clients = new Map<string, PeerClientTransport>();
    private readonly semanticInFlight = new Map<string, Promise<unknown>>();
    private readonly disabledRelationships = new Set<string>();
    private closed = false;

    constructor(private readonly options: OutboundPeerServiceOptions) {}

    async handle(request: RemotePeerRequest, signal?: AbortSignal): Promise<unknown> {
        const relationship = this.relationship(request.params.relationshipId);
        const client = this.client(relationship);
        switch (request.type) {
            case 'peer.remote.list': {
                const sessions = (await client.request('session.list', {}, signal)).flatMap((session) => {
                    const agentName = currentSessionAgentName(session);
                    return agentName === undefined ? [] : [{ session, agentName }];
                });
                const nameCounts = new Map<string, number>();
                for (const { agentName } of sessions) {
                    nameCounts.set(key(agentName), (nameCounts.get(key(agentName)) ?? 0) + 1);
                }
                const machineAlias = await this.ensureMachineAlias(relationship);
                return {
                    machineAlias,
                    sessions: sessions.map(({ session, agentName }) => ({
                        sessionId: session.id,
                        agentName,
                        ...(nameCounts.get(key(agentName))! > 1 ? { ambiguous: true as const } : {}),
                    })),
                } satisfies PeerRequestResult<'peer.remote.list'>;
            }
            case 'peer.remote.read': {
                const agentName = await this.currentAgentName(client, request.params.sessionId, signal);
                const result = await client.request('pane.read', { sessionId: request.params.sessionId, ...(request.params.lines === undefined ? {} : { lines: request.params.lines }), source: 'recent' }, signal);
                return { machineAlias: await this.ensureMachineAlias(relationship), agentName, ...result };
            }
            case 'peer.remote.status': {
                const agentName = await this.currentAgentName(client, request.params.sessionId, signal);
                const status = await client.request('session.status', { sessionId: request.params.sessionId }, signal);
                return { machineAlias: await this.ensureMachineAlias(relationship), agentName, status };
            }
            case 'peer.remote.watch':
            case 'peer.remote.prompt':
            case 'peer.remote.start':
                return this.semantic(request, signal);
        }
    }

    async acknowledgeSemantic(request: SemanticRemoteRequest): Promise<void> {
        const semanticHash = this.semanticHash(request);
        const stored = this.options.store.semanticMutations().find((entry) => entry.relationshipId === request.params.relationshipId
            && entry.type === request.type && entry.semanticHash === semanticHash && entry.state === 'completed');
        if (stored !== undefined) await this.options.store.putSemanticMutation({ ...stored, state: 'delivered', updatedAt: this.options.now() });
    }

    /** Resume source-side operations whose directed result was lost before it was durably recorded. */
    recoverOutstanding(): void {
        for (const stored of this.options.store.semanticMutations()) {
            if (stored.state === 'pending' && stored.notValidAfter > this.options.now()) void this.runStored(stored).catch(() => undefined);
        }
    }

    async relationships(): Promise<StoredPeerRelationship[]> {
        const outbound = this.options.store.list().peers.flatMap((entry) => {
            const stored = this.options.store.relationship(entry.relationshipId);
            return stored?.direction === 'outbound' && stored.state === 'connected' ? [stored] : [];
        });
        for (const entry of outbound) await this.ensureMachineAlias(entry);
        return outbound.map((entry) => this.options.store.relationship(entry.relationshipId) ?? entry);
    }

    async resolveMachine(alias: string): Promise<StoredPeerRelationship> {
        const relationships = await this.relationships();
        const exact = relationships.filter((entry) => key(entry.machineAlias ?? '') === key(alias));
        if (exact.length === 1) return exact[0]!;
        if (exact.length > 1) throw new Error('More than one allowed computer has that alias.');
        const byName = relationships.filter((entry) => key(name(entry.machineName, 'Peer computer')) === key(alias));
        if (byName.length === 0) throw new Error('No allowed computer with that name is available.');
        if (byName.length > 1) throw new Error('Use one of the qualified computer aliases from list machines.');
        return byName[0]!;
    }

    closeRelationship(id: string): void {
        this.disabledRelationships.add(id);
        this.clients.get(id)?.close();
        this.clients.delete(id);
    }

    close(): void {
        this.closed = true;
        for (const client of this.clients.values()) client.close();
        this.clients.clear();
    }

    private async semantic(request: SemanticRemoteRequest, signal?: AbortSignal): Promise<unknown> {
        const { mutation: requestedMutation } = request.params;
        const semanticHash = this.semanticHash(request);
        let stored = this.options.store.semanticMutations().find((entry) => entry.relationshipId === request.params.relationshipId
            && entry.type === request.type && entry.semanticHash === semanticHash && entry.notValidAfter > this.options.now()
            && (entry.state !== 'delivered' || entry.operationId === requestedMutation.operationId));
        if (stored?.state === 'completed' && stored.outcome !== undefined) return this.storedOutcome(stored);
        if (stored === undefined) {
            stored = {
                relationshipId: request.params.relationshipId,
                type: request.type,
                semanticHash,
                operationId: requestedMutation.operationId,
                notValidAfter: requestedMutation.notValidAfter,
                params: request.params,
                state: 'pending',
                updatedAt: this.options.now(),
            };
            await this.options.store.putSemanticMutation(stored);
        }
        try { return await this.runStored(stored, signal); }
        catch (error) {
            const aborted = (error as { name?: unknown }).name === 'AbortError';
            const dispatched = (error as { dispatched?: unknown }).dispatched === true;
            if (aborted && stored.type === 'peer.remote.prompt' && dispatched) {
                queueMicrotask(() => { void this.runStored(stored).catch(() => undefined); });
            } else if (aborted) {
                await this.options.store.putSemanticMutation({
                    ...stored,
                    state: 'delivered',
                    outcome: { ok: false, error: 'peer operation cancelled', code: 'peer-operation-cancelled' },
                    updatedAt: this.options.now(),
                });
            }
            throw error;
        }
    }

    private semanticHash(request: SemanticRemoteRequest): string {
        const { mutation: _mutation, ...params } = request.params;
        return createHash('sha256').update(JSON.stringify({ type: request.type, params })).digest('base64url');
    }

    private runStored(stored: StoredSemanticMutation, signal?: AbortSignal): Promise<unknown> {
        const existing = this.semanticInFlight.get(stored.operationId);
        if (existing !== undefined && signal === undefined) return existing;
        let run!: Promise<unknown>;
        run = (async () => {
            try {
                const data = await this.performStored(stored, signal);
                await this.options.store.putSemanticMutation({
                    ...stored, state: 'completed', outcome: { ok: true, data }, updatedAt: this.options.now(),
                });
                return data;
            } catch (error) {
                if ((error as { name?: unknown }).name === 'AbortError') throw error;
                const code = (error as { code?: unknown }).code;
                const outcome = {
                    ok: false as const,
                    error: error instanceof Error ? error.message : String(error),
                    ...(typeof code === 'string' ? { code } : {}),
                };
                await this.options.store.putSemanticMutation({
                    ...stored,
                    state: outcome.code === 'peer-mutation-unresolved' ? 'completed' : 'delivered',
                    outcome,
                    updatedAt: this.options.now(),
                });
                throw operationError(outcome.error, outcome.code ?? 'peer-operation-failed');
            } finally {
                if (this.semanticInFlight.get(stored.operationId) === run) this.semanticInFlight.delete(stored.operationId);
            }
        })();
        this.semanticInFlight.set(stored.operationId, run);
        return run;
    }

    private async performStored(stored: StoredSemanticMutation, signal?: AbortSignal): Promise<unknown> {
        const relationship = this.relationship(stored.relationshipId);
        const client = this.client(relationship);
        if (stored.type === 'peer.remote.watch') {
            const params = stored.params as Extract<SemanticRemoteRequest, { type: 'peer.remote.watch' }>['params'];
            const agentName = await this.currentAgentName(client, params.sessionId, signal);
            const result = await client.request('agent.watch', {
                sessionId: params.sessionId,
                ...(params.until === undefined ? {} : { until: params.until }),
                ...(params.timeoutMs === undefined ? {} : { timeoutMs: params.timeoutMs }),
                peerMutation: params.mutation,
            }, signal);
            if (result.settlement === undefined) throw operationError('peer watch returned before settlement', 'peer-watch-unsettled');
            return {
                machineAlias: await this.ensureMachineAlias(relationship),
                agentName,
                settlement: result.settlement,
            } satisfies PeerRequestResult<'peer.remote.watch'>;
        }
        if (stored.type === 'peer.remote.prompt') {
            const params = stored.params as Extract<SemanticRemoteRequest, { type: 'peer.remote.prompt' }>['params'];
            const agentName = await this.currentAgentName(client, params.sessionId, signal);
            await client.request('session.prompt', {
                sessionId: params.sessionId,
                text: `Peer message from ${name(this.options.sourceMachineName, 'Peer computer')}:\n${params.text}`,
                ...(params.streamingBehavior === undefined ? {} : { streamingBehavior: params.streamingBehavior }),
                peerMutation: params.mutation,
            }, signal);
            return { machineAlias: await this.ensureMachineAlias(relationship), agentName, delivered: true } satisfies PeerRequestResult<'peer.remote.prompt'>;
        }
        const params = stored.params as Extract<SemanticRemoteRequest, { type: 'peer.remote.start' }>['params'];
        const snapshot = await client.request('session.start', {
            cwd: params.cwd,
            ...(params.kind === undefined ? {} : { kind: params.kind }),
            ...(params.label === undefined ? {} : { label: params.label }),
            peerMutation: params.mutation,
        }, signal);
        if (!('info' in snapshot)) {
            throw operationError(snapshot.acceptance.message, snapshot.acceptance.code);
        }
        const agentName = currentSessionAgentName(snapshot.info) ?? 'Agent';
        return {
            machineAlias: await this.ensureMachineAlias(relationship),
            sessionId: snapshot.info.id,
            agentName,
        } satisfies PeerRequestResult<'peer.remote.start'>;
    }

    private storedOutcome(stored: StoredSemanticMutation): unknown {
        if (stored.outcome?.ok === true) return stored.outcome.data;
        throw operationError(stored.outcome?.error ?? 'peer operation outcome is missing', stored.outcome?.code ?? 'peer-operation-failed');
    }

    private relationship(id: string): StoredPeerRelationship {
        const relationship = this.options.store.relationship(id);
        if (this.closed || this.disabledRelationships.has(id)
            || relationship === undefined || relationship.direction !== 'outbound' || relationship.state !== 'connected'
            || relationship.credential === undefined || relationship.peerKey === undefined || relationship.sealedGrant === undefined
            || relationship.relayUrl === undefined || relationship.targetMachineSigningPublicKey === undefined) {
            throw operationError('peer relationship is not connected', 'peer-not-connected');
        }
        return relationship;
    }

    private client(relationship: StoredPeerRelationship): PeerClientTransport {
        if (this.closed || this.disabledRelationships.has(relationship.relationshipId)) {
            throw operationError('peer relationship is not connected', 'peer-not-connected');
        }
        const existing = this.clients.get(relationship.relationshipId);
        if (existing !== undefined) return existing;
        const created = this.options.clientFactory?.(relationship) ?? new NodePeerClient({
            relayUrl: relationship.relayUrl!,
            machineId: relationship.machineId,
            credential: relationship.credential!,
            peerDeviceId: relationship.peerDeviceId!,
            peerKey: relationship.peerKey!,
            pinnedMachineSigningPublicKey: relationship.targetMachineSigningPublicKey!,
            sealedGrant: relationship.sealedGrant!,
            ...(relationship.grantPath === undefined ? {} : { grantPath: relationship.grantPath }),
            ...(this.options.onConnectionDiagnostic === undefined ? {} : { onConnectionDiagnostic: this.options.onConnectionDiagnostic }),
        });
        this.clients.set(relationship.relationshipId, created);
        return created;
    }

    private async ensureMachineAlias(relationship: StoredPeerRelationship): Promise<string> {
        if (relationship.machineAlias?.trim()) return relationship.machineAlias;
        const base = name(relationship.machineName, 'Peer computer');
        const used = new Set(this.options.store.list().peers.flatMap((entry) => {
            const stored = this.options.store.relationship(entry.relationshipId);
            return stored?.direction === 'outbound' && stored.state !== 'revoked'
                && stored.relationshipId !== relationship.relationshipId && stored.machineAlias
                ? [key(stored.machineAlias)] : [];
        }));
        let alias = base;
        if (used.has(key(alias))) alias = `${base} (${name(relationship.platform, 'computer')})`;
        for (let suffix = 2; used.has(key(alias)); suffix += 1) alias = `${base} (${name(relationship.platform, 'computer')}) ${suffix}`;
        await this.options.store.putRelationship({ ...relationship, machineAlias: alias });
        return alias;
    }

    private async currentAgentName(
        client: PeerClientTransport,
        sessionId: string,
        signal?: AbortSignal,
    ): Promise<string> {
        const sessions: SessionInfo[] = await client.request('session.list', {}, signal);
        const session = sessions.find((candidate) => candidate.id === sessionId);
        return session === undefined ? 'Agent' : currentSessionAgentName(session) ?? 'Agent';
    }
}
