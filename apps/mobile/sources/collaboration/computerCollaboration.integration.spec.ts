import { describe, expect, it, vi } from 'vitest';
import type { PeerRelationship, PeerRequestMap, PeerRequestType, SignedPeerDescriptor } from '@muxr/contract';

vi.mock('@react-native-async-storage/async-storage', () => ({
    default: { getItem: vi.fn(), setItem: vi.fn() },
}));
vi.mock('expo-crypto', () => ({ randomUUID: () => 'unused-random-id' }));

import {
    applyCollaboration,
    selectCollaborationMachines,
    type CollaborationMachine,
    type PeerRequester,
} from './computerCollaboration';

interface MutationCall {
    machineId: string;
    type: PeerRequestType;
    operationId: string;
    notValidAfter: number;
    params: string;
}

class FakeMachineClient {
    online = true;
    failNext?: PeerRequestType;
    peers: PeerRelationship[] = [];

    constructor(
        readonly machine: CollaborationMachine,
        private readonly fleet: Map<string, FakeMachineClient>,
        private readonly calls: string[],
        private readonly mutations: MutationCall[],
    ) {}

    async request<T extends PeerRequestType>(type: T, params: PeerRequestMap[T]['params']): Promise<PeerRequestMap[T]['result']> {
        if (!this.online) throw new Error('offline');
        if (type === 'peer.list') return { peers: this.peers } as PeerRequestMap[T]['result'];
        const mutation = (params as { mutation?: { operationId: string; notValidAfter: number } }).mutation;
        if (mutation !== undefined) this.mutations.push({ machineId: this.machine.machineId, type, ...mutation, params: JSON.stringify(params) });
        if (this.failNext === type) {
            this.failNext = undefined;
            throw new Error('transport dropped after send');
        }
        if (type === 'peer.prepare') {
            const input = params as PeerRequestMap['peer.prepare']['params'];
            this.calls.push(`prepare:${this.machine.name}->${this.fleet.get(input.targetMachineId)!.machine.name}`);
            const descriptor: SignedPeerDescriptor = {
                v: 1,
                claims: {
                    v: 1,
                    sourceMachineId: this.machine.machineId,
                    sourceMachineSigningPublicKey: this.machine.machineSigningPublicKey,
                    targetMachineId: input.targetMachineId,
                    targetMachineSigningPublicKey: input.targetMachineSigningPublicKey,
                    peerPublicKey: `key-${this.machine.machineId}-${input.targetMachineId}`,
                    preparedAt: 1_000,
                    expiresAt: 301_000,
                    nonce: 'nonce',
                    sourceName: this.machine.name,
                    sourcePlatform: this.machine.platform,
                },
                signature: 'signed',
            };
            return { preparationId: 'prepared', descriptor, expiresAt: 301_000 } as PeerRequestMap[T]['result'];
        }
        if (type === 'peer.authorize') {
            const input = params as PeerRequestMap['peer.authorize']['params'];
            const sourceId = input.descriptor.claims.sourceMachineId;
            const relationshipId = input.relationshipId!;
            const peerDeviceId = `peer-${sourceId}-${this.machine.machineId}`;
            this.calls.push(`authorize:${this.fleet.get(sourceId)!.machine.name}->${this.machine.name}`);
            this.peers.push({
                relationshipId,
                direction: 'inbound',
                machineId: sourceId,
                machineName: this.fleet.get(sourceId)!.machine.name,
                platform: this.fleet.get(sourceId)!.machine.platform,
                state: 'connected',
                capabilities: [...input.capabilities],
                peerDeviceId,
                createdAt: 1_000,
                updatedAt: 1_000,
            });
            return {
                peerDeviceId,
                sealedBundle: JSON.stringify({ sourceId, targetId: this.machine.machineId, relationshipId, peerDeviceId }),
                capabilities: input.capabilities,
                keyVersion: 1,
            } as PeerRequestMap[T]['result'];
        }
        if (type === 'peer.install') {
            const input = params as PeerRequestMap['peer.install']['params'];
            const bundle = JSON.parse(input.sealedBundle) as { sourceId: string; targetId: string; relationshipId: string; peerDeviceId: string };
            this.calls.push(`install:${this.machine.name}->${this.fleet.get(bundle.targetId)!.machine.name}`);
            this.peers.push({
                relationshipId: bundle.relationshipId,
                direction: 'outbound',
                machineId: bundle.targetId,
                machineName: this.fleet.get(bundle.targetId)!.machine.name,
                platform: this.fleet.get(bundle.targetId)!.machine.platform,
                state: 'connected',
                capabilities: ['list', 'read', 'status', 'watch', 'prompt'],
                peerDeviceId: bundle.peerDeviceId,
                createdAt: 1_000,
                updatedAt: 1_000,
            });
            return this.peers[this.peers.length - 1] as PeerRequestMap[T]['result'];
        }
        if (type === 'peer.revoke') {
            const input = params as PeerRequestMap['peer.revoke']['params'];
            const peer = this.peers.find((entry) => entry.relationshipId === input.relationshipId && entry.state !== 'revoked');
            if (peer === undefined) return { state: 'already-revoked', revokedAt: 2_000 } as PeerRequestMap[T]['result'];
            if (peer.direction === 'outbound') {
                const targetInbound = this.fleet.get(peer.machineId)!.peers.find((entry) => entry.relationshipId === peer.relationshipId
                    && entry.direction === 'inbound' && entry.state !== 'revoked');
                if (targetInbound !== undefined) throw new Error('unsafe outbound cleanup before inbound revocation');
            }
            this.calls.push(`revoke:${this.machine.name}:${peer.direction}:${peer.relationshipId}`);
            peer.state = 'revoked';
            return { state: 'revoked', revokedAt: 2_000 } as PeerRequestMap[T]['result'];
        }
        throw new Error(`unexpected request ${type}`);
    }
}

describe('computer collaboration flow', () => {
    it('sets up both directions, resumes offline work, and revokes inbound access before outbound cleanup', async () => {
        const machines: CollaborationMachine[] = [
            { machineId: 'linux-internal', name: 'Linux workstation', platform: 'Linux', machineSigningPublicKey: 'linux-signing-key' },
            { machineId: 'mac-internal', name: 'Build Mac', platform: 'macOS', machineSigningPublicKey: 'mac-signing-key' },
        ];
        const calls: string[] = [];
        const mutations: MutationCall[] = [];
        const fleet = new Map<string, FakeMachineClient>();
        for (const machine of machines) fleet.set(machine.machineId, new FakeMachineClient(machine, fleet, calls, mutations));
        const request = (async (machineId, type, params) => fleet.get(machineId)!.request(type, params)) as PeerRequester;
        let sequence = 0;
        const newId = () => `stable-${++sequence}`;
        const persisted: string[] = [];
        const save = async (intent: unknown) => { persisted.push(JSON.stringify(intent)); };
        const now = () => 1_000;

        let intent = selectCollaborationMachines({ version: 1, selectedMachineIds: [], machines: [], edges: [] }, machines, newId);
        const relationshipIds = intent.edges.map((edge) => edge.relationshipId);
        fleet.get('mac-internal')!.online = false;
        let report = await applyCollaboration(intent, machines, request, save, now, newId);
        expect(Object.values(report.states)).toEqual(['Waiting for computer', 'Waiting for computer']);
        expect(calls).toEqual([]);
        expect(report.intent.edges.every((edge) => edge.setup !== undefined)).toBe(true);

        fleet.get('mac-internal')!.online = true;
        fleet.get('linux-internal')!.failNext = 'peer.prepare';
        report = await applyCollaboration(report.intent, machines, request, save, now, newId);
        expect(Object.values(report.states)).toEqual(['Setting up', 'Setting up']);
        const failedPrepare = mutations.find((entry) => entry.machineId === 'linux-internal' && entry.type === 'peer.prepare')!;

        machines[0]!.name = 'Renamed Linux workstation';
        report = await applyCollaboration(report.intent, machines, request, save, now, newId);
        expect(Object.values(report.states)).toEqual(['Connected', 'Connected']);
        expect(report.intent.edges.map((edge) => edge.relationshipId)).toEqual(relationshipIds);
        const retriedPrepare = mutations.filter((entry) => entry.machineId === 'linux-internal' && entry.type === 'peer.prepare')[1]!;
        expect(retriedPrepare).toEqual(failedPrepare);
        expect(mutations.every((entry) => entry.operationId !== '' && entry.notValidAfter === 301_000)).toBe(true);
        expect(calls).toEqual([
            'prepare:Build Mac->Linux workstation',
            'authorize:Build Mac->Linux workstation',
            'install:Build Mac->Linux workstation',
            'prepare:Renamed Linux workstation->Build Mac',
            'authorize:Renamed Linux workstation->Build Mac',
            'install:Renamed Linux workstation->Build Mac',
        ]);
        expect([...fleet.values()].flatMap((client) => client.peers.filter((peer) => peer.state === 'connected'))).toHaveLength(4);

        intent = selectCollaborationMachines(report.intent, [], newId);
        fleet.get('mac-internal')!.online = false;
        report = await applyCollaboration(intent, machines, request, save, now, newId);
        expect(Object.values(report.states)).toEqual(['Disconnecting', 'Disconnecting']);
        expect(fleet.get('linux-internal')!.peers.some((peer) => peer.direction === 'outbound' && peer.state === 'connected')).toBe(true);
        expect(report.intent.edges.every((edge) => edge.disconnect !== undefined)).toBe(true);

        fleet.get('mac-internal')!.online = true;
        report = await applyCollaboration(report.intent, machines, request, save, now, newId);
        expect(report.intent.edges).toEqual([]);
        expect([...fleet.values()].flatMap((client) => client.peers.filter((peer) => peer.state === 'connected'))).toEqual([]);
        for (const edge of intent.edges) {
            const targetRevoke = calls.findIndex((call) => call === `revoke:${fleet.get(edge.targetMachineId)!.machine.name}:inbound:${edge.relationshipId}`);
            const sourceCleanup = calls.findIndex((call) => call === `revoke:${fleet.get(edge.sourceMachineId)!.machine.name}:outbound:${edge.relationshipId}`);
            expect(targetRevoke).toBeGreaterThanOrEqual(0);
            expect(sourceCleanup).toBeGreaterThan(targetRevoke);
        }
    });
});
