import { describe, expect, it, vi } from 'vitest';
import type { PeerRelationship, PeerRequestMap, PeerRequestType, SignedPeerDescriptor } from '@muxr/contract';
import AsyncStorage from '@react-native-async-storage/async-storage';

vi.mock('@react-native-async-storage/async-storage', () => ({
    default: { getItem: vi.fn(), setItem: vi.fn() },
}));
vi.mock('expo-crypto', () => ({ randomUUID: () => 'unused-random-id' }));

import {
    applyCollaboration,
    collaborationSummary,
    hasPendingCollaboration,
    loadCollaborationIntent,
    reconcileCollaboration,
    selectCollaborationMachines,
    PeerHostResponseError,
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
    listError?: Error;
    failNext?: PeerRequestType;
    offlineMachineAfterAuthorize?: string;
    peers: PeerRelationship[] = [];

    constructor(
        readonly machine: CollaborationMachine,
        private readonly fleet: Map<string, FakeMachineClient>,
        private readonly calls: string[],
        private readonly mutations: MutationCall[],
    ) {}

    async request<T extends PeerRequestType>(type: T, params: PeerRequestMap[T]['params']): Promise<PeerRequestMap[T]['result']> {
        if (!this.online) throw new Error('offline');
        if (type === 'peer.list' && this.listError !== undefined) throw this.listError;
        if (type === 'peer.list') return { peers: this.peers } as PeerRequestMap[T]['result'];
        const mutation = (params as { mutation?: { operationId: string; notValidAfter: number } }).mutation;
        if (mutation !== undefined) this.mutations.push({ machineId: this.machine.machineId, type, ...mutation, params: JSON.stringify(params) });
        if (this.failNext === type) {
            this.failNext = undefined;
            throw new Error('transport dropped after send');
        }
        if (type === 'peer.remote.list') return { machineAlias: 'Peer computer', sessions: [] } as PeerRequestMap[T]['result'];
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
            if (this.peers.some((peer) => peer.relationshipId === relationshipId && peer.direction === 'inbound' && peer.state === 'connected')) {
                throw new PeerHostResponseError('already authorized', 'peer-already-authorized');
            }
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
            if (this.offlineMachineAfterAuthorize !== undefined) this.fleet.get(this.offlineMachineAfterAuthorize)!.online = false;
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
    it('normalizes stored authority, sets up both directions, resumes offline work, and revokes inbound access before outbound cleanup', async () => {
        vi.mocked(AsyncStorage.getItem).mockResolvedValueOnce(JSON.stringify({
            version: 1,
            selectedMachineIds: ['linux-internal', 'linux-internal', 42],
            machines: [
                { machineId: 'linux-internal', name: 'Linux workstation', machineSigningPublicKey: 'linux-signing-key' },
                { machineId: 'mac-internal', name: 'Build Mac', machineSigningPublicKey: 'mac-signing-key' },
            ],
            edges: [
                { sourceMachineId: 'linux-internal', targetMachineId: 'mac-internal', relationshipId: 'duplicate-edge', setup: { prepareMutation: { operationId: 7 } } },
                { sourceMachineId: 'linux-internal', targetMachineId: 'mac-internal', relationshipId: 'duplicate-edge', disconnect: 'corrupt' },
                { sourceMachineId: 'linux-internal', targetMachineId: 'missing-machine', relationshipId: 'missing-endpoint' },
                { sourceMachineId: 'linux-internal', targetMachineId: 'linux-internal', relationshipId: 'self-edge' },
            ],
        }));
        const normalizedStored = await loadCollaborationIntent();
        expect(normalizedStored.selectedMachineIds).toEqual(['linux-internal']);
        expect(normalizedStored.edges).toEqual([expect.objectContaining({
            relationshipId: 'duplicate-edge',
            disconnect: { repair: true },
        })]);

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
        expect(collaborationSummary(report.intent)).toBe('Setting up');
        expect(report.issues['mac-internal']).toMatchObject({ kind: 'offline' });
        expect(calls).toEqual([]);
        expect(report.intent.edges.every((edge) => edge.setup !== undefined)).toBe(true);

        fleet.get('mac-internal')!.online = true;
        fleet.get('mac-internal')!.listError = new PeerHostResponseError('unknown request type', 'host-contract-mismatch');
        report = await applyCollaboration(report.intent, machines, request, save, now, newId);
        expect(report.issues['mac-internal']).toEqual({ kind: 'outdated', message: 'Run `muxr update` on this computer, then retry.' });
        expect(calls).toEqual([]);

        fleet.get('mac-internal')!.listError = undefined;
        fleet.get('linux-internal')!.failNext = 'peer.prepare';
        report = await applyCollaboration(report.intent, machines, request, save, now, newId);
        expect(Object.values(report.states)).toEqual(['Setting up', 'Setting up']);
        expect(report.errors).toEqual({ 'linux-internal': 'Computer unavailable. Start muxr on this computer, then retry.' });
        const failedPrepare = mutations.find((entry) => entry.machineId === 'linux-internal' && entry.type === 'peer.prepare')!;

        machines[0]!.name = 'Renamed Linux workstation';
        fleet.get('mac-internal')!.offlineMachineAfterAuthorize = 'linux-internal';
        report = await applyCollaboration(report.intent, machines, request, save, now, newId);
        expect(Object.values(report.states)).toEqual(['Waiting for computer', 'Waiting for computer']);
        expect(collaborationSummary(report.intent)).toBe('Setting up');
        expect(report.intent.edges.every((edge) => edge.setup?.repairNeeded !== true)).toBe(true);
        expect(calls.some((call) => call.startsWith('revoke:'))).toBe(false);

        fleet.get('mac-internal')!.offlineMachineAfterAuthorize = undefined;
        fleet.get('linux-internal')!.online = true;
        report = await applyCollaboration(report.intent, machines, request, save, now, newId);
        expect(Object.values(report.states)).toEqual(['Connected', 'Connected']);
        expect(collaborationSummary(report.intent)).toBe('2 computers');
        expect(report.intent.edges.map((edge) => edge.relationshipId)).toEqual(relationshipIds);
        const retriedPrepare = mutations.filter((entry) => entry.machineId === 'linux-internal' && entry.type === 'peer.prepare')[1]!;
        expect(retriedPrepare).toEqual(failedPrepare);
        expect(mutations.every((entry) => entry.operationId !== '' && entry.notValidAfter === 301_000)).toBe(true);
        expect(mutations.filter((entry) => entry.type === 'peer.authorize').every((entry) => JSON.parse(entry.params).targetRelayUrl === undefined)).toBe(true);
        expect(calls).toEqual([
            'prepare:Build Mac->Linux workstation',
            'authorize:Build Mac->Linux workstation',
            'install:Build Mac->Linux workstation',
            'prepare:Renamed Linux workstation->Build Mac',
            'authorize:Renamed Linux workstation->Build Mac',
            'install:Renamed Linux workstation->Build Mac',
        ]);
        expect([...fleet.values()].flatMap((client) => client.peers.filter((peer) => peer.state === 'connected'))).toHaveLength(4);

        const recovered = await reconcileCollaboration({ version: 1, selectedMachineIds: [], machines: [], edges: [] }, machines, request);
        expect(recovered.intent.selectedMachineIds.sort()).toEqual(['linux-internal', 'mac-internal']);
        expect(recovered.intent.edges.map((edge) => edge.relationshipId).sort()).toEqual([...relationshipIds].sort());
        const selectedAgain = selectCollaborationMachines(recovered.intent, machines, newId);
        expect(selectedAgain.edges.map((edge) => edge.relationshipId).sort()).toEqual([...relationshipIds].sort());
        expect(hasPendingCollaboration({ ...selectedAgain, edges: [] })).toBe(true);

        fleet.get('linux-internal')!.failNext = 'peer.remote.list';
        const staleRuntime = await reconcileCollaboration(recovered.intent, machines, request);
        const staleEdge = staleRuntime.intent.edges.find((edge) => edge.sourceMachineId === 'linux-internal')!;
        expect(staleEdge.setup).toMatchObject({ repairNeeded: true });
        expect(staleRuntime.errors).toEqual({ 'linux-internal': 'Computer unavailable. Start muxr on this computer, then retry.' });
        report = await applyCollaboration(staleRuntime.intent, machines, request, save, now, newId);
        expect(Object.values(report.states)).toEqual(['Connected', 'Connected']);
        expect(report.intent.edges).not.toContainEqual(expect.objectContaining({ relationshipId: staleEdge.relationshipId }));
        expect(report.intent.edges.find((edge) => edge.sourceMachineId === 'linux-internal')?.setup).toBeUndefined();

        const orphan: PeerRelationship = {
            relationshipId: 'orphan-live-authority', direction: 'outbound', machineId: 'mac-internal', machineName: 'Build Mac',
            state: 'connected', capabilities: ['list', 'read', 'status', 'watch', 'prompt'], peerDeviceId: 'orphan-device', createdAt: 1_000, updatedAt: 1_000,
        };
        fleet.get('linux-internal')!.peers.push(orphan);
        const repair = await reconcileCollaboration({ version: 1, selectedMachineIds: [], machines: [], edges: [] }, machines, request);
        expect(repair.intent.edges).toContainEqual(expect.objectContaining({ relationshipId: 'orphan-live-authority', setup: expect.objectContaining({ repairNeeded: true }) }));
        expect(Object.values(repair.states)).toEqual(['Repair needed', 'Repair needed']);
        expect(collaborationSummary(repair.intent)).toBe('Needs attention');
        fleet.get('linux-internal')!.peers = fleet.get('linux-internal')!.peers.filter((peer) => peer !== orphan);

        const lostReceiptEdge = report.intent.edges.find((edge) => edge.sourceMachineId === 'linux-internal')!;
        fleet.get('linux-internal')!.peers = fleet.get('linux-internal')!.peers.filter((peer) => peer.relationshipId !== lostReceiptEdge.relationshipId);
        lostReceiptEdge.setup = {};
        report = await applyCollaboration(report.intent, machines, request, save, now, newId);
        expect(report.intent.edges.find((edge) => edge.relationshipId === lostReceiptEdge.relationshipId)?.setup?.repairNeeded).toBe(true);
        expect(collaborationSummary(report.intent)).toBe('Needs attention');
        report = await applyCollaboration(report.intent, machines, request, save, now, newId);
        expect(Object.values(report.states)).toEqual(['Connected', 'Connected']);

        intent = selectCollaborationMachines(report.intent, [], newId);
        fleet.get('mac-internal')!.online = false;
        report = await applyCollaboration(intent, machines, request, save, now, newId);
        expect(Object.values(report.states)).toEqual(['Disconnecting', 'Disconnecting']);
        expect(collaborationSummary(report.intent)).toBe('Disconnecting');
        expect(fleet.get('linux-internal')!.peers.some((peer) => peer.direction === 'outbound' && peer.state === 'connected')).toBe(true);
        expect(report.intent.edges.every((edge) => edge.disconnect !== undefined)).toBe(true);

        intent = selectCollaborationMachines(report.intent, machines, newId);
        fleet.get('mac-internal')!.online = true;
        report = await applyCollaboration(intent, machines, request, save, now, newId);
        expect(Object.values(report.states)).toEqual(['Connected', 'Connected']);
        expect(report.intent.edges).toHaveLength(2);
        expect(report.intent.edges.every((edge) => edge.setup === undefined && edge.disconnect === undefined)).toBe(true);

        intent = selectCollaborationMachines(report.intent, [], newId);
        fleet.get('mac-internal')!.online = false;
        report = await applyCollaboration(intent, machines, request, save, now, newId);
        for (const edge of report.intent.edges) edge.disconnect!.targetRevoked = true;
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
