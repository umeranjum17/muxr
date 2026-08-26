import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { isPeerCapabilities, type PeerAuthorityMetadata, type PeerCapability, type PeerClientRequest, type PeerRelationship, type SignedPeerDescriptor } from '@muxr/contract';
import type { KeyPair, SealedDeviceGrant } from '@muxr/crypto';
import { atomicWriteJson } from '../domain/atomicWriteJson.js';
import type { PeerAuthorityIssueRecovery } from './authority.js';

export interface StoredPreparation {
    preparationId: string;
    targetMachineId: string;
    targetMachineSigningPublicKey: string;
    key: KeyPair;
    descriptor: SignedPeerDescriptor;
    expiresAt: number;
}

export interface StoredPeerRelationship extends PeerRelationship {
    preparationId?: string;
    targetMachineSigningPublicKey?: string;
    peerKey?: KeyPair;
    relayUrl?: string;
    credential?: string;
    sealedGrant?: SealedDeviceGrant;
    grantPath?: string;
    allowedCwds?: string[];
    /** Stable, non-secret selector exposed to voice/tool callers. */
    machineAlias?: string;
    /** Session ids stay private; only these human aliases leave the host. */
    agentAliases?: Record<string, string>;
    authorizationDescriptorHash?: string;
    sealedInstallBundle?: string;
}

export interface StoredPendingAuthorization {
    version: 1;
    relationshipId: string;
    descriptor: SignedPeerDescriptor;
    descriptorHash: string;
    sourceMachineId: string;
    sourceName?: string;
    sourcePlatform?: string;
    peerPublicKey: string;
    capabilities: PeerCapability[];
    allowedCwds?: string[];
    /** Target endpoint verified by the phone pairing and pinned into the install bundle. */
    relayUrl?: string;
    createdAt: number;
    authorityRecovery?: PeerAuthorityIssueRecovery;
    issued?: {
        peerDeviceId: string;
        credential: string;
        authority: PeerAuthorityMetadata;
        recovery?: PeerAuthorityIssueRecovery;
        grantPath?: string;
    };
    ingressKey?: string;
    peerDataKey?: string;
    sealedBundle?: string;
}

export interface StoredPeerReceipt {
    deviceId: string;
    operationId: string;
    requestHash: string;
    notValidAfter: number;
    state: 'started' | 'completed';
    outcome?: { ok: true; data: unknown } | { ok: false; error: string; code?: string };
}

type SemanticPeerRequest = Extract<PeerClientRequest, { type: 'peer.remote.watch' | 'peer.remote.prompt' | 'peer.remote.start' }>;

export interface StoredSemanticMutation {
    relationshipId: string;
    type: SemanticPeerRequest['type'];
    semanticHash: string;
    operationId: string;
    notValidAfter: number;
    params: SemanticPeerRequest['params'];
    state: 'pending' | 'completed' | 'delivered';
    outcome?: { ok: true; data: unknown } | { ok: false; error: string; code?: string };
    updatedAt: number;
}

interface PeerState {
    version: 1;
    revision: number;
    preparations: StoredPreparation[];
    relationships: StoredPeerRelationship[];
    receipts: StoredPeerReceipt[];
    semanticMutations?: StoredSemanticMutation[];
    pendingAuthorization?: StoredPendingAuthorization;
}

function validState(value: unknown): value is PeerState {
    if (typeof value !== 'object' || value === null) return false;
    const state = value as Partial<PeerState>;
    return state.version === 1 && Number.isInteger(state.revision)
        && Array.isArray(state.preparations) && Array.isArray(state.relationships) && Array.isArray(state.receipts)
        && state.preparations.every((entry) => typeof entry?.preparationId === 'string' && entry.preparationId !== ''
            && typeof entry?.targetMachineId === 'string' && typeof entry?.key?.publicKey === 'string'
            && typeof entry.key.secretKey === 'string' && typeof entry?.expiresAt === 'number')
        && state.relationships.every((entry) => typeof entry?.relationshipId === 'string' && entry.relationshipId !== ''
            && typeof entry.machineId === 'string' && entry.machineId !== '' && isPeerCapabilities(entry.capabilities)
            && (entry.direction === 'inbound' || entry.direction === 'outbound')
            && (entry.state === 'pending' || entry.state === 'connected' || entry.state === 'repair-needed'
                || entry.state === 'disconnecting' || entry.state === 'revoked')
            && (entry.relayUrl === undefined || typeof entry.relayUrl === 'string' && entry.relayUrl !== '')
            && (entry.machineAlias === undefined || typeof entry.machineAlias === 'string' && entry.machineAlias !== '')
            && (entry.agentAliases === undefined || typeof entry.agentAliases === 'object' && entry.agentAliases !== null
                && Object.values(entry.agentAliases).every((alias) => typeof alias === 'string' && alias !== ''))
            && typeof entry.createdAt === 'number' && typeof entry.updatedAt === 'number')
        && state.receipts.every((entry) => typeof entry?.deviceId === 'string' && typeof entry?.operationId === 'string'
            && typeof entry?.requestHash === 'string' && Number.isFinite(entry?.notValidAfter)
            && (entry.state === 'started' || entry.state === 'completed')
            && (entry.state === 'started' ? entry.outcome === undefined : entry.outcome !== undefined))
        && (state.semanticMutations === undefined || Array.isArray(state.semanticMutations)
            && state.semanticMutations.every((entry) => typeof entry?.relationshipId === 'string' && typeof entry?.semanticHash === 'string'
                && typeof entry?.operationId === 'string' && Number.isFinite(entry?.notValidAfter) && Number.isFinite(entry?.updatedAt)
                && (entry.type === 'peer.remote.watch' || entry.type === 'peer.remote.prompt' || entry.type === 'peer.remote.start')
                && typeof entry.params === 'object' && entry.params !== null
                && (entry.state === 'pending' || entry.state === 'completed' || entry.state === 'delivered')
                && (entry.state === 'pending' ? entry.outcome === undefined : entry.outcome !== undefined)))
        && (state.pendingAuthorization === undefined
            || state.pendingAuthorization.version === 1
                && typeof state.pendingAuthorization.relationshipId === 'string'
                && typeof state.pendingAuthorization.descriptorHash === 'string'
                && typeof state.pendingAuthorization.sourceMachineId === 'string'
                && typeof state.pendingAuthorization.peerPublicKey === 'string'
                && isPeerCapabilities(state.pendingAuthorization.capabilities)
                && (state.pendingAuthorization.relayUrl === undefined || typeof state.pendingAuthorization.relayUrl === 'string'
                    && state.pendingAuthorization.relayUrl !== '')
                && Number.isFinite(state.pendingAuthorization.createdAt));
}

export class PeerStore {
    private readonly filePath: string;
    private state: PeerState;
    private writes = Promise.resolve();

    constructor(dataDir: string) {
        this.filePath = join(dataDir, 'peers.json');
        mkdirSync(dirname(this.filePath), { recursive: true, mode: 0o700 });
        chmodSync(dirname(this.filePath), 0o700);
        if (!existsSync(this.filePath)) {
            this.state = { version: 1, revision: 0, preparations: [], relationships: [], receipts: [] };
            return;
        }
        const info = lstatSync(this.filePath);
        if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077) !== 0) {
            throw new Error(`${this.filePath} must be a regular owner-only file`);
        }
        let parsed: unknown;
        try { parsed = JSON.parse(readFileSync(this.filePath, 'utf8')) as unknown; }
        catch { throw new Error(`${this.filePath} contains malformed JSON`); }
        if (!validState(parsed)) throw new Error(`${this.filePath} has an unsupported peer schema`);
        this.state = parsed;
        this.prune(this.state, Date.now());
    }

    list(): { peers: PeerRelationship[]; revision: number } {
        const pending = this.state.pendingAuthorization;
        return {
            peers: [
                ...this.state.relationships,
                ...(pending === undefined || this.state.relationships.some((entry) => entry.relationshipId === pending.relationshipId) ? [] : [{
                    relationshipId: pending.relationshipId,
                    direction: 'inbound' as const,
                    machineId: pending.sourceMachineId,
                    ...(pending.sourceName === undefined ? {} : { machineName: pending.sourceName }),
                    ...(pending.sourcePlatform === undefined ? {} : { platform: pending.sourcePlatform }),
                    state: 'repair-needed' as const,
                    capabilities: [...pending.capabilities],
                    ...(pending.issued === undefined ? {} : { peerDeviceId: pending.issued.peerDeviceId }),
                    createdAt: pending.createdAt,
                    updatedAt: pending.createdAt,
                }]),
            ].map((entry) => ({
                relationshipId: entry.relationshipId,
                direction: entry.direction,
                machineId: entry.machineId,
                ...(entry.machineName === undefined ? {} : { machineName: entry.machineName }),
                ...(entry.platform === undefined ? {} : { platform: entry.platform }),
                state: entry.state,
                capabilities: [...entry.capabilities],
                ...(entry.peerDeviceId === undefined ? {} : { peerDeviceId: entry.peerDeviceId }),
                createdAt: entry.createdAt,
                updatedAt: entry.updatedAt,
                ...(entry.keyVersion === undefined ? {} : { keyVersion: entry.keyVersion }),
                ...(entry.authority === undefined ? {} : { authority: { ...entry.authority } }),
            })),
            revision: this.state.revision,
        };
    }

    preparation(id: string): StoredPreparation | undefined {
        return this.state.preparations.find((entry) => entry.preparationId === id);
    }

    preparationsForTarget(machineId: string): StoredPreparation[] {
        return this.state.preparations.filter((entry) => entry.targetMachineId === machineId);
    }

    relationship(id: string): StoredPeerRelationship | undefined {
        return this.state.relationships.find((entry) => entry.relationshipId === id);
    }

    authorization(descriptorHash: string): StoredPeerRelationship | undefined {
        return this.state.relationships.find((entry) => entry.authorizationDescriptorHash === descriptorHash);
    }

    pendingAuthorization(): StoredPendingAuthorization | undefined {
        return this.state.pendingAuthorization;
    }

    receipt(deviceId: string, operationId: string): StoredPeerReceipt | undefined {
        return this.state.receipts.find((entry) => entry.deviceId === deviceId && entry.operationId === operationId);
    }

    semanticMutations(): StoredSemanticMutation[] {
        return structuredClone(this.state.semanticMutations ?? []);
    }

    async putSemanticMutation(mutation: StoredSemanticMutation): Promise<void> {
        await this.mutate((state) => {
            state.semanticMutations = (state.semanticMutations ?? []).filter((entry) => entry.operationId !== mutation.operationId);
            if (state.semanticMutations.length >= 128) throw new Error('peer semantic mutation capacity is full until active operations expire');
            state.semanticMutations.push(mutation);
        });
    }

    async putPreparation(preparation: StoredPreparation): Promise<void> {
        await this.mutate((state) => {
            state.preparations = state.preparations.filter((entry) => entry.preparationId !== preparation.preparationId);
            state.preparations.push(preparation);
        });
    }

    async removePreparation(preparationId: string): Promise<void> {
        await this.mutate((state) => {
            state.preparations = state.preparations.filter((entry) => entry.preparationId !== preparationId);
        });
    }

    async putRelationship(relationship: StoredPeerRelationship): Promise<void> {
        await this.mutate((state) => {
            state.relationships = state.relationships.filter((entry) => entry.relationshipId !== relationship.relationshipId);
            state.relationships.push(relationship);
        });
    }

    async putPendingAuthorization(pending: StoredPendingAuthorization | undefined): Promise<void> {
        await this.mutate((state) => {
            if (pending === undefined) delete state.pendingAuthorization;
            else state.pendingAuthorization = pending;
        });
    }

    async putReceipt(receipt: StoredPeerReceipt): Promise<void> {
        await this.mutate((state) => {
            this.prune(state, Date.now());
            state.receipts = state.receipts.filter((entry) =>
                entry.deviceId !== receipt.deviceId || entry.operationId !== receipt.operationId);
            if (state.receipts.filter((entry) => entry.deviceId === receipt.deviceId).length >= 64) {
                throw new Error('peer receipt capacity is full for this device until active mutations expire');
            }
            if (state.receipts.length >= 2048) throw new Error('peer receipt capacity is full until active mutations expire');
            state.receipts.push(receipt);
        });
    }

    async removeReceipt(deviceId: string, operationId: string): Promise<void> {
        await this.mutate((state) => {
            state.receipts = state.receipts.filter((entry) => entry.deviceId !== deviceId || entry.operationId !== operationId);
        });
    }

    private prune(state: PeerState, now: number): void {
        state.preparations = state.preparations.filter((entry) => entry.expiresAt > now);
        state.receipts = state.receipts.filter((entry) => entry.notValidAfter > now);
        state.semanticMutations = (state.semanticMutations ?? []).filter((entry) => entry.notValidAfter > now);
    }

    private mutate(change: (state: PeerState) => void): Promise<void> {
        const run = this.writes.then(async () => {
            const next = structuredClone(this.state);
            change(next);
            next.revision += 1;
            await atomicWriteJson(this.filePath, next);
            chmodSync(this.filePath, 0o600);
            this.state = next;
        });
        this.writes = run.then(() => undefined, () => undefined);
        return run;
    }
}
