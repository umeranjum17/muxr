import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { isPeerCapabilities, type PeerRelationship, type SignedPeerDescriptor } from '@muxr/contract';
import type { KeyPair, SealedDeviceGrant } from '@muxr/crypto';
import { atomicWriteJson } from '../domain/atomicWriteJson.js';

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
    allowedCwds?: string[];
    agentAliases?: Record<string, string>;
}

export interface StoredPeerReceipt {
    deviceId: string;
    operationId: string;
    requestHash: string;
    notValidAfter: number;
    state: 'started' | 'completed';
    outcome?: { ok: true; data: unknown } | { ok: false; error: string; code?: string };
}

interface PeerState {
    version: 1;
    revision: number;
    preparations: StoredPreparation[];
    relationships: StoredPeerRelationship[];
    receipts: StoredPeerReceipt[];
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
            && typeof entry.createdAt === 'number' && typeof entry.updatedAt === 'number')
        && state.receipts.every((entry) => typeof entry?.deviceId === 'string' && typeof entry?.operationId === 'string'
            && typeof entry?.requestHash === 'string' && Number.isFinite(entry?.notValidAfter)
            && (entry.state === 'started' || entry.state === 'completed')
            && (entry.state === 'started' ? entry.outcome === undefined : entry.outcome !== undefined));
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
        return {
            peers: this.state.relationships.map((entry) => ({
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

    receipt(deviceId: string, operationId: string): StoredPeerReceipt | undefined {
        return this.state.receipts.find((entry) => entry.deviceId === deviceId && entry.operationId === operationId);
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

    async putReceipt(receipt: StoredPeerReceipt): Promise<void> {
        await this.mutate((state) => {
            this.prune(state, Date.now());
            state.receipts = state.receipts.filter((entry) =>
                entry.deviceId !== receipt.deviceId || entry.operationId !== receipt.operationId);
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
