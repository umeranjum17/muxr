import { mkdtempSync, statSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createConnection } from 'node:net';
import { describe, expect, it } from 'vitest';
import {
    DEFAULT_PEER_CAPABILITIES,
    type ClientRequest,
    type PeerClientRequest,
    type PeerRequestParams,
    type PeerRequestResult,
    type PeerRequestType,
    type RequestParams,
    type RequestResult,
} from '@muxr/contract';
import {
    deriveV2Key,
    generateKeyPair,
    generateSigningKeyPair,
    newV2ReplayTracker,
    openV2,
    verifyDeviceGrant,
} from '@muxr/crypto';
import { HostV2Crypto } from '../hostedE2ee.js';
import { createRequestDispatcher } from '../requests/createRequestDispatcher.js';
import type { SessionSource } from '../sessionSource.js';
import type { PeerAuthority } from './authority.js';
import type { PeerClientRequestType, PeerClientTransport } from './client.js';
import { PeerBroker, type PeerBrokerRequest } from './broker.js';
import { PeerRuntime } from './runtime.js';
import type { MachineCryptoAdapter, MachineCryptoState, MachineRotationGrant } from './types.js';

class FakeAuthority implements PeerAuthority {
    readonly kind = 'selfhost' as const;
    readonly grants = new Map<string, string>();
    readonly revoked = new Set<string>();
    rotations: MachineRotationGrant[][] = [];
    private next = 0;

    async issuePeer(input: Parameters<PeerAuthority['issuePeer']>[0]) {
        const peerDeviceId = `peer-${++this.next}`;
        return {
            peerDeviceId,
            credential: `credential-${peerDeviceId}`,
            authority: {
                authorityId: 'fake:selfhost',
                credentialExpiresAt: input.credentialExpiresAt,
                refreshAfter: input.refreshAfter,
            },
        };
    }

    async uploadGrant(peerDeviceId: string, grant: string): Promise<void> { this.grants.set(peerDeviceId, grant); }
    async revokePeer(peerDeviceId: string): Promise<void> { this.revoked.add(peerDeviceId); }
    async publishRotation(_keyVersion: number, grants: MachineRotationGrant[]): Promise<void> { this.rotations.push(grants); }
}

function machineCrypto(): { adapter: MachineCryptoAdapter; current(): MachineCryptoState } {
    const signing = generateSigningKeyPair();
    const box = generateKeyPair();
    let state: MachineCryptoState = {
        signingPublicKey: signing.publicKey,
        signingSecretKey: signing.secretKey,
        boxPublicKey: box.publicKey,
        boxSecretKey: box.secretKey,
        dataKey: randomBytes(32).toString('base64'),
        keyVersion: 1,
        devices: [],
    };
    return {
        adapter: { get: () => state, commit: async (next) => { state = next; } },
        current: () => state,
    };
}

async function call<T extends PeerRequestType>(
    runtime: PeerRuntime,
    type: T,
    params: PeerRequestParams<T>,
): Promise<PeerRequestResult<T>> {
    return runtime.handle({ type, requestId: `phone-${Math.random()}`, params } as PeerClientRequest, 'phone-control') as Promise<PeerRequestResult<T>>;
}

async function brokerCall(socketPath: string, request: PeerBrokerRequest): Promise<unknown> {
    return new Promise((resolve, reject) => {
        const socket = createConnection(socketPath);
        let input = '';
        socket.on('connect', () => socket.write(`${JSON.stringify({ id: 'voice-flow', request })}\n`));
        socket.on('data', (chunk) => {
            input += chunk.toString('utf8');
            const newline = input.indexOf('\n');
            if (newline === -1) return;
            const response = JSON.parse(input.slice(0, newline)) as { ok: boolean; data?: unknown; error?: string };
            socket.destroy();
            if (response.ok) resolve(response.data); else reject(new Error(response.error));
        });
        socket.on('error', reject);
    });
}

describe('host peer collaboration flow', () => {
    it('prepares, authorizes, installs, executes one fresh prompt, rejects unsafe work, and revokes', async () => {
        const root = mkdtempSync(join(tmpdir(), 'muxr-peer-flow-'));
        const sourceKeys = machineCrypto();
        const targetKeys = machineCrypto();
        const sourceAuthority = new FakeAuthority();
        const targetAuthority = new FakeAuthority();
        let prompts = 0;
        const session = {
            id: 'muxr-session-ios',
            cwd: '/work/app',
            path: 'internal-pane-path',
            name: 'iOS builder',
            created: new Date().toISOString(),
            modified: new Date().toISOString(),
            messageCount: 0,
            firstMessage: '',
            agentKind: 'pi',
        };
        let remoteSessions = [session];
        const targetSource = {
            async list() { return remoteSessions; },
            async prompt() { prompts += 1; },
            async paneRead() { return { text: 'build complete', truncated: false }; },
            async status(sessionId: string) {
                return { sessionId, agentStatus: 'idle', isStreaming: false, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, cost: 0, usageLimits: { capturedAt: new Date().toISOString(), windows: [] } };
            },
            async agentWatch() { return { watching: true }; },
        } as unknown as SessionSource;
        let targetDispatch: ReturnType<typeof createRequestDispatcher>['dispatch'];
        const sourceRuntime = new PeerRuntime({
            dataDir: join(root, 'source'),
            machineId: 'source-machine',
            machineName: 'Linux builder',
            platform: 'Linux',
            relayUrl: 'ws://relay.test',
            crypto: sourceKeys.adapter,
            authority: sourceAuthority,
            clientFactory: (relationship) => new class implements PeerClientTransport {
                async connect(): Promise<void> {}
                async request<T extends PeerClientRequestType>(type: T, params: RequestParams<T>): Promise<RequestResult<T>> {
                    const response = await targetDispatch({ type, requestId: `peer-${Math.random()}`, params } as ClientRequest, relationship.peerDeviceId);
                    if (!response.ok) throw Object.assign(new Error(response.error), { code: response.code });
                    return response.data as RequestResult<T>;
                }
                close(): void {}
            }(),
        });
        const targetRuntime = new PeerRuntime({
            dataDir: join(root, 'target'),
            machineId: 'target-machine',
            machineName: 'Build Mac',
            platform: 'macOS',
            relayUrl: 'ws://relay.test',
            crypto: targetKeys.adapter,
            authority: targetAuthority,
        });
        const makeTargetDispatcher = (runtime: PeerRuntime) => createRequestDispatcher({
            source: targetSource,
            domain: {} as never,
            machineId: 'target-machine',
            machineName: 'Build Mac',
            hostVersion: 'test',
            peerRuntime: runtime,
            canMutateDevice: () => false,
            getDeviceContext: (deviceId) => {
                const device = targetKeys.current().devices.find((entry) => entry.deviceId === deviceId);
                return device?.kind === 'peer' ? {
                    kind: 'peer',
                    ...(device.capabilities === undefined ? {} : { capabilities: device.capabilities }),
                    ...(device.allowedCwds === undefined ? {} : { allowedCwds: device.allowedCwds }),
                } : undefined;
            },
        });
        targetDispatch = makeTargetDispatcher(targetRuntime).dispatch;
        const fresh = (operationId: string) => ({ operationId, notValidAfter: Date.now() + 60_000 });

        const prepared = await call(sourceRuntime, 'peer.prepare', {
            targetMachineId: 'target-machine',
            targetMachineSigningPublicKey: targetKeys.current().signingPublicKey,
            mutation: fresh('prepare'),
        });
        const authorized = await call(targetRuntime, 'peer.authorize', {
            descriptor: prepared.descriptor,
            capabilities: [...DEFAULT_PEER_CAPABILITIES],
            mutation: fresh('authorize'),
        });
        const installed = await call(sourceRuntime, 'peer.install', {
            targetMachineId: 'target-machine',
            sealedBundle: authorized.sealedBundle,
            mutation: fresh('install'),
        });
        expect(installed).toMatchObject({ direction: 'outbound', machineName: 'Build Mac', state: 'connected' });
        expect(targetAuthority.grants.has(authorized.peerDeviceId)).toBe(true);
        expect(targetKeys.current().devices[0]).toMatchObject({ kind: 'peer', capabilities: DEFAULT_PEER_CAPABILITIES });
        expect(targetKeys.current().devices[0]!.dataKey).not.toBe(targetKeys.current().dataKey);
        const outbound = sourceRuntime.store.relationship(installed.relationshipId)!;
        const peerGrant = verifyDeviceGrant(outbound.sealedGrant!, {
            pinnedMachineSigningPublicKey: outbound.targetMachineSigningPublicKey!,
            deviceKey: outbound.peerKey!,
            deviceId: authorized.peerDeviceId,
        });
        const hostCrypto = new HostV2Crypto({
            machineId: 'target-machine',
            keyVersion: targetKeys.current().keyVersion,
            dataKey: targetKeys.current().dataKey,
            ingressKeys: { [authorized.peerDeviceId]: peerGrant.ingressKey },
            deviceDataKeys: { [authorized.peerDeviceId]: peerGrant.dataKey },
        });
        const broadcast = hostCrypto.seal('session', 'machine', 'native-only');
        expect(() => openV2(broadcast, deriveV2Key(peerGrant.dataKey, 'host->client'), {
            machineId: 'target-machine', senderId: 'target-machine', recipientId: '*',
            channel: 'session', streamId: 'machine', keyVersion: 1,
        }, newV2ReplayTracker())).toThrow(/authentication/);
        const directed = hostCrypto.seal('session', 'machine', 'peer-result', authorized.peerDeviceId);
        expect(openV2(directed, deriveV2Key(peerGrant.dataKey, 'host->client'), {
            machineId: 'target-machine', senderId: 'target-machine', recipientId: authorized.peerDeviceId,
            channel: 'session', streamId: 'machine', keyVersion: 1,
        }, newV2ReplayTracker())).toBe('peer-result');

        const listed = await call(sourceRuntime, 'peer.remote.list', { relationshipId: installed.relationshipId });
        expect(listed).toEqual({ machineAlias: 'Build Mac', sessions: [{ sessionId: 'muxr-session-ios', agentAlias: 'iOS builder' }] });
        const promptMutation = fresh('prompt-once');
        await call(sourceRuntime, 'peer.remote.prompt', {
            relationshipId: installed.relationshipId,
            sessionId: 'muxr-session-ios',
            text: 'Run the iOS build',
            mutation: promptMutation,
        });
        expect(prompts).toBe(1);

        // Recreate the target runtime to prove the operation receipt, not memory, owns retry safety.
        const restartedTarget = new PeerRuntime({
            dataDir: join(root, 'target'),
            machineId: 'target-machine',
            machineName: 'Build Mac',
            platform: 'macOS',
            relayUrl: 'ws://relay.test',
            crypto: targetKeys.adapter,
            authority: targetAuthority,
        });
        targetDispatch = makeTargetDispatcher(restartedTarget).dispatch;
        await call(sourceRuntime, 'peer.remote.prompt', {
            relationshipId: installed.relationshipId,
            sessionId: 'muxr-session-ios',
            text: 'Run the iOS build',
            mutation: promptMutation,
        });
        expect(prompts).toBe(1);

        await expect(call(sourceRuntime, 'peer.remote.prompt', {
            relationshipId: installed.relationshipId,
            sessionId: 'muxr-session-ios',
            text: 'Too late',
            mutation: { operationId: 'expired', notValidAfter: Date.now() - 1 },
        })).rejects.toMatchObject({ code: 'peer-mutation-expired' });
        expect(prompts).toBe(1);

        await expect(targetDispatch({
            type: 'machine.shell', requestId: 'forbidden', params: { command: 'echo unsafe', cwd: '/tmp' },
        }, authorized.peerDeviceId)).resolves.toMatchObject({ ok: false, code: 'peer-forbidden' });

        const broker = new PeerBroker(join(root, 'source', 'voice.sock'), sourceRuntime);
        await broker.start();
        expect(statSync(broker.socketPath).mode & 0o077).toBe(0);
        const brokerList = await brokerCall(broker.socketPath, { method: 'list', machine: 'Build Mac' });
        expect(brokerList).toEqual({ machines: [{ machine: 'Build Mac', agents: [{ agent: 'iOS builder' }] }] });
        await expect(brokerCall(broker.socketPath, { method: 'list' })).resolves.toEqual(brokerList);
        expect(JSON.stringify(brokerList)).not.toMatch(/target-machine|muxr-session|internal-pane-path/);
        await expect(brokerCall(broker.socketPath, { method: 'read', machine: 'Build Mac', agent: 'iOS builder' }))
            .resolves.toEqual({ machine: 'Build Mac', agent: 'iOS builder', text: 'build complete', truncated: false });
        await expect(brokerCall(broker.socketPath, { method: 'prompt', machine: 'Build Mac', agent: 'iOS builder', text: 'Report build status' }))
            .resolves.toEqual({ machine: 'Build Mac', agent: 'iOS builder', delivered: true });
        expect(prompts).toBe(2);
        remoteSessions = [session, { ...session, id: 'another-internal-session' }];
        await expect(brokerCall(broker.socketPath, { method: 'read', machine: 'Build Mac', agent: 'iOS builder' }))
            .rejects.toThrow('More than one agent on the selected computer has that name');
        await broker.close();

        await call(restartedTarget, 'peer.revoke', {
            relationshipId: restartedTarget.store.list().peers[0]!.relationshipId,
            peerDeviceId: authorized.peerDeviceId,
            mutation: fresh('revoke-target'),
        });
        expect(targetAuthority.revoked.has(authorized.peerDeviceId)).toBe(true);
        expect(targetKeys.current().devices).toEqual([]);
        expect(targetAuthority.rotations).toHaveLength(1);

        await call(sourceRuntime, 'peer.revoke', {
            relationshipId: installed.relationshipId,
            peerDeviceId: authorized.peerDeviceId,
            mutation: fresh('revoke-source'),
        });
        expect(sourceRuntime.store.list().peers).toEqual([expect.objectContaining({ state: 'revoked', machineName: 'Build Mac' })]);
    });
});
