import type {
    PeerClientRequest,
    PeerRequestResult,
    SessionInfo,
} from '@muxr/contract';
import { NodePeerClient, type PeerClientTransport } from './client.js';
import { PeerStore, type StoredPeerRelationship } from './store.js';

type RemotePeerRequest = Extract<PeerClientRequest, { type: `peer.remote.${string}` }>;

export interface OutboundPeerServiceOptions {
    store: PeerStore;
    now: () => number;
    clientFactory?: (relationship: StoredPeerRelationship) => PeerClientTransport;
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

/** Outbound routing, transport ownership, and stable human selectors. */
export class OutboundPeerService {
    private readonly clients = new Map<string, PeerClientTransport>();

    constructor(private readonly options: OutboundPeerServiceOptions) {}

    async handle(request: RemotePeerRequest): Promise<unknown> {
        const relationship = this.relationship(request.params.relationshipId);
        const client = this.client(relationship);
        switch (request.type) {
            case 'peer.remote.list': {
                const sessions = await client.request('session.list', {});
                const agentAliases = this.agentAliases(sessions);
                const machineAlias = await this.ensureMachineAlias(relationship);
                await this.options.store.putRelationship({ ...relationship, machineAlias, agentAliases, updatedAt: this.options.now() });
                return {
                    machineAlias,
                    sessions: sessions.map((session) => ({ sessionId: session.id, agentAlias: agentAliases[session.id]! })),
                } satisfies PeerRequestResult<'peer.remote.list'>;
            }
            case 'peer.remote.read': {
                const result = await client.request('pane.read', { sessionId: request.params.sessionId, ...(request.params.lines === undefined ? {} : { lines: request.params.lines }), source: 'recent' });
                return { machineAlias: await this.ensureMachineAlias(relationship), agentAlias: this.knownAgentAlias(relationship, request.params.sessionId), ...result };
            }
            case 'peer.remote.status': {
                const status = await client.request('session.status', { sessionId: request.params.sessionId });
                return { machineAlias: await this.ensureMachineAlias(relationship), agentAlias: this.knownAgentAlias(relationship, request.params.sessionId), status };
            }
            case 'peer.remote.watch': {
                const result = await client.request('agent.watch', {
                    sessionId: request.params.sessionId,
                    ...(request.params.until === undefined ? {} : { until: request.params.until }),
                    ...(request.params.timeoutMs === undefined ? {} : { timeoutMs: request.params.timeoutMs }),
                    peerMutation: request.params.mutation,
                });
                if (result.settlement === undefined) throw operationError('peer watch returned before settlement', 'peer-watch-unsettled');
                return {
                    machineAlias: await this.ensureMachineAlias(relationship),
                    agentAlias: this.knownAgentAlias(relationship, request.params.sessionId),
                    settlement: result.settlement,
                } satisfies PeerRequestResult<'peer.remote.watch'>;
            }
            case 'peer.remote.prompt': {
                await client.request('session.prompt', {
                    sessionId: request.params.sessionId,
                    text: request.params.text,
                    ...(request.params.streamingBehavior === undefined ? {} : { streamingBehavior: request.params.streamingBehavior }),
                    peerMutation: request.params.mutation,
                });
                return { machineAlias: await this.ensureMachineAlias(relationship), agentAlias: this.knownAgentAlias(relationship, request.params.sessionId), delivered: true };
            }
            case 'peer.remote.start': {
                const snapshot = await client.request('session.start', {
                    cwd: request.params.cwd,
                    ...(request.params.kind === undefined ? {} : { kind: request.params.kind }),
                    ...(request.params.label === undefined ? {} : { label: request.params.label }),
                    peerMutation: request.params.mutation,
                });
                const alias = this.baseAgentAlias(snapshot.info);
                await this.options.store.putRelationship({
                    ...relationship,
                    updatedAt: this.options.now(),
                    agentAliases: { ...(relationship.agentAliases ?? {}), [snapshot.info.id]: alias },
                });
                return { machineAlias: await this.ensureMachineAlias(relationship), sessionId: snapshot.info.id, agentAlias: alias };
            }
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
        this.clients.get(id)?.close();
        this.clients.delete(id);
    }

    close(): void {
        for (const client of this.clients.values()) client.close();
        this.clients.clear();
    }

    private relationship(id: string): StoredPeerRelationship {
        const relationship = this.options.store.relationship(id);
        if (relationship === undefined || relationship.direction !== 'outbound' || relationship.state !== 'connected'
            || relationship.credential === undefined || relationship.peerKey === undefined || relationship.sealedGrant === undefined
            || relationship.relayUrl === undefined || relationship.targetMachineSigningPublicKey === undefined) {
            throw operationError('peer relationship is not connected', 'peer-not-connected');
        }
        return relationship;
    }

    private client(relationship: StoredPeerRelationship): PeerClientTransport {
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
        });
        this.clients.set(relationship.relationshipId, created);
        return created;
    }

    private async ensureMachineAlias(relationship: StoredPeerRelationship): Promise<string> {
        if (relationship.machineAlias?.trim()) return relationship.machineAlias;
        const base = name(relationship.machineName, 'Peer computer');
        const used = new Set(this.options.store.list().peers.flatMap((entry) => {
            const stored = this.options.store.relationship(entry.relationshipId);
            return stored?.direction === 'outbound' && stored.relationshipId !== relationship.relationshipId && stored.machineAlias
                ? [key(stored.machineAlias)] : [];
        }));
        let alias = base;
        if (used.has(key(alias))) alias = `${base} (${name(relationship.platform, 'computer')})`;
        for (let suffix = 2; used.has(key(alias)); suffix += 1) alias = `${base} (${name(relationship.platform, 'computer')}) ${suffix}`;
        await this.options.store.putRelationship({ ...relationship, machineAlias: alias });
        return alias;
    }

    private agentAliases(sessions: SessionInfo[]): Record<string, string> {
        const groups = new Map<string, SessionInfo[]>();
        for (const session of sessions) {
            const base = this.baseAgentAlias(session);
            groups.set(key(base), [...(groups.get(key(base)) ?? []), session]);
        }
        const aliases: Record<string, string> = {};
        for (const group of groups.values()) {
            const base = this.baseAgentAlias(group[0]!);
            if (group.length === 1) {
                aliases[group[0]!.id] = base;
                continue;
            }
            const ordered = [...group].sort((a, b) => `${a.created}\0${a.id}`.localeCompare(`${b.created}\0${b.id}`));
            const candidates = ordered.map((session) => {
                const qualifier = name(session.tabLabel, '') || name(session.agentKind, 'agent');
                return key(qualifier) === key(base) ? `${base} (agent)` : `${base} (${qualifier})`;
            });
            const counts = new Map<string, number>();
            for (const candidate of candidates) counts.set(key(candidate), (counts.get(key(candidate)) ?? 0) + 1);
            ordered.forEach((session, index) => {
                const candidate = candidates[index]!;
                aliases[session.id] = counts.get(key(candidate)) === 1 ? candidate : `${candidate} ${index + 1}`;
            });
        }
        return aliases;
    }

    private baseAgentAlias(session: SessionInfo): string {
        return name(session.name, '') || name(session.tabLabel, '') || name(session.agentKind, '') || 'Agent';
    }

    private knownAgentAlias(relationship: StoredPeerRelationship, sessionId: string): string {
        return relationship.agentAliases?.[sessionId] ?? 'Agent';
    }
}
