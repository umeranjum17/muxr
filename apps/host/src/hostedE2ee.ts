import type { PeerCapability } from '@muxr/contract';
import {
    deriveV2Key,
    newV2ReplayTracker,
    newV2SenderState,
    openV2,
    sealV2,
    v2ReplayFromSnapshot,
    type V2Context,
    type V2ReplaySnapshot,
    type V2ReplayTracker,
    type V2SenderState,
} from '@muxr/crypto';

export interface HostedMachineKeys {
    machineId: string;
    keyVersion: number;
    dataKey: string;
    ingressKeys: Readonly<Record<string, string>>;
    deviceKinds?: Readonly<Record<string, 'native' | 'browser' | 'peer'>>;
    deviceAuthorities?: Readonly<Record<string, 'control' | 'observe'>>;
    /** Peer-only egress roots keep peers off the native/browser broadcast stream. */
    deviceDataKeys?: Readonly<Record<string, string>>;
    deviceCapabilities?: Readonly<Record<string, readonly PeerCapability[]>>;
    deviceAllowedCwds?: Readonly<Record<string, readonly string[]>>;
    deviceExpiresAt?: Readonly<Record<string, number>>;
    replaySnapshots?: Record<string, V2ReplaySnapshot>;
    onReplayChange?: (snapshots: Record<string, V2ReplaySnapshot>) => void;
}

export interface HostedDeviceKeys {
    machineId: string;
    deviceId: string;
    keyVersion: number;
    dataKey: string;
    ingressKey: string;
}

/** Small state owner shared by relay and terminal sockets. Relay never gets these roots. */
export class HostV2Crypto {
    private readonly senders = new Map<string, V2SenderState>();
    private readonly replays = new Map<string, V2ReplayTracker>();
    private readonly ephemeralReplays = new Set<string>();
    private generation: string;
    private outputKey: string;

    constructor(readonly keys: HostedMachineKeys) {
        this.generation = `${keys.keyVersion}\0${keys.dataKey}`;
        this.outputKey = deriveV2Key(keys.dataKey, 'host->client');
    }

    private syncGeneration(): void {
        const current = `${this.keys.keyVersion}\0${this.keys.dataKey}`;
        if (current === this.generation) return;
        this.generation = current;
        this.outputKey = deriveV2Key(this.keys.dataKey, 'host->client');
        this.senders.clear();
        this.replays.clear();
        this.ephemeralReplays.clear();
    }

    seal(channel: 'session' | 'terminal' | 'attachment' | 'stream', streamId: string, plaintext: string, recipientId = '*'): string {
        this.syncGeneration();
        const peerRoot = recipientId === '*' ? undefined : this.keys.deviceDataKeys?.[recipientId];
        if (recipientId !== '*' && peerRoot === undefined) throw new Error('hosted e2ee: directed recipient has no egress key');
        const stateKey = `${recipientId}\0${channel}`;
        const state = this.senders.get(stateKey) ?? newV2SenderState();
        this.senders.set(stateKey, state);
        return sealV2(plaintext, peerRoot === undefined ? this.outputKey : deriveV2Key(peerRoot, 'host->client'), {
            machineId: this.keys.machineId,
            senderId: this.keys.machineId,
            recipientId,
            channel,
            streamId,
            keyVersion: this.keys.keyVersion,
        }, state);
    }

    open(deviceId: string, channel: 'session' | 'terminal' | 'attachment' | 'stream', streamId: string, payload: string): string {
        this.syncGeneration();
        const root = this.keys.ingressKeys[deviceId];
        if (root === undefined || (this.keys.deviceExpiresAt?.[deviceId] ?? Infinity) <= Date.now()) {
            throw new Error('hosted e2ee: sender has no active device grant');
        }
        const replayKey = `${deviceId}\0${channel}\0${streamId}`;
        const snapshot = channel === 'stream' ? undefined : this.keys.replaySnapshots?.[replayKey];
        const replay = this.replays.get(replayKey) ?? (snapshot === undefined ? newV2ReplayTracker() : v2ReplayFromSnapshot(snapshot));
        this.replays.set(replayKey, replay);
        if (channel === 'stream') this.ephemeralReplays.add(replayKey);
        const context: V2Context = {
            machineId: this.keys.machineId,
            senderId: deviceId,
            recipientId: this.keys.machineId,
            channel,
            streamId,
            keyVersion: this.keys.keyVersion,
        };
        const plaintext = openV2(payload, deriveV2Key(root, 'client->host'), context, replay);
        if (channel !== 'stream' && this.keys.onReplayChange !== undefined) {
            const snapshots = { ...(this.keys.replaySnapshots ?? {}) };
            for (const [key, value] of this.replays) {
                if (!this.ephemeralReplays.has(key)) snapshots[key] = value.toSnapshot();
            }
            this.keys.onReplayChange(snapshots);
        }
        return plaintext;
    }

    /** Ephemeral stream replay state lives only for its attached socket. */
    releaseReplay(deviceId: string, channel: 'stream', streamId: string): void {
        const replayKey = `${deviceId}\0${channel}\0${streamId}`;
        this.replays.delete(replayKey);
        this.ephemeralReplays.delete(replayKey);
    }
}
