import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createConnection } from 'node:net';
import { WebSocketServer } from 'ws';
import { describe, expect, it } from 'vitest';
import {
    DEFAULT_PEER_CAPABILITIES,
    decodePayload,
    encodePayload,
    relayControlUrl,
    type ClientRequest,
    type Envelope,
    type PeerClientRequest,
    type PeerRequestParams,
    type PeerRequestResult,
    type PeerRequestType,
    type RequestParams,
    type RequestResult,
} from '@muxr/contract';
import {
    createDeviceGrant,
    deriveV2Key,
    generateKeyPair,
    generateSigningKeyPair,
    newV2ReplayTracker,
    newV2SenderState,
    openV2,
    sealV2,
    v2EnvelopeSequence,
    verifyDeviceGrant,
} from '@muxr/crypto';
import { HostV2Crypto, connectToRelay, type MachineCryptoAdapter, type MachineCryptoState, type MachineRotationGrant } from '../../machine/index.js';
import { createRequestDispatcher } from '../../requests/index.js';
import { HostDiagnosticsJournal } from '../../diagnostics/index.js';
import type { SessionSource } from '../../agent/index.js';
import { HttpPeerAuthority, type PeerAuthority } from '../infrastructure/authority.js';
import { NodePeerClient, type PeerClientRequestType, type PeerClientTransport, type PeerConnectionDiagnostic } from '../infrastructure/client.js';
import { PeerStore } from '../infrastructure/store.js';
import { PeerBroker } from '../infrastructure/broker.js';
import { PeerRuntime } from './runtime.js';

class FakeAuthority implements PeerAuthority {
    readonly kind = 'selfhost' as const;
    readonly grants = new Map<string, string>();
    readonly revoked = new Set<string>();
    rotations: MachineRotationGrant[][] = [];
    failGrantUploads = 0;
    failRevokes = 0;
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

    async uploadGrant(peerDeviceId: string, grant: string): Promise<void> {
        if (this.failGrantUploads-- > 0) throw new Error('simulated grant upload interruption');
        this.grants.set(peerDeviceId, grant);
    }
    async revokePeer(peerDeviceId: string): Promise<void> {
        if (this.failRevokes-- > 0) throw new Error('simulated authority revocation outage');
        this.revoked.add(peerDeviceId);
    }
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

async function waitFor(predicate: () => boolean, message: string, timeoutMs = 5_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!predicate() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
    if (!predicate()) throw new Error(`Timed out waiting for ${message}`);
}

async function peerCli(accessFile: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
    const cli = fileURLToPath(new URL('../../../../../scripts/cli.mjs', import.meta.url));
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [cli, 'peers', ...args], {
            env: { ...process.env, MUXR_PEER_ACCESS_FILE: accessFile },
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        let stdout = '';
        let stderr = '';
        const timeout = setTimeout(() => child.kill('SIGKILL'), 10_000);
        child.stdout.on('data', (chunk) => { stdout += chunk; });
        child.stderr.on('data', (chunk) => { stderr += chunk; });
        child.on('error', reject);
        child.on('close', (code) => {
            clearTimeout(timeout);
            resolve({ code: code ?? 1, stdout, stderr });
        });
    });
}

async function brokerCall(socketPath: string, capability: string, request: unknown, acknowledge: boolean | 'invalid' = true): Promise<unknown> {
    return new Promise((resolve, reject) => {
        const socket = createConnection(socketPath);
        let input = '';
        let settled = false;
        const finish = (error?: Error, value?: unknown): void => {
            if (settled) return;
            settled = true;
            socket.destroy();
            if (error === undefined) resolve(value); else reject(error);
        };
        socket.on('connect', () => socket.write(`${JSON.stringify({ id: 'voice-flow', capability, request })}\n`));
        socket.on('data', (chunk) => {
            input += chunk.toString('utf8');
            const newline = input.indexOf('\n');
            if (newline === -1) return;
            const response = JSON.parse(input.slice(0, newline)) as { id: string; ok: boolean; data?: unknown; error?: string; ackId?: string };
            if (!response.ok) return finish(new Error(response.error));
            if (response.ackId === undefined || !acknowledge) return finish(undefined, response.data);
            const ack = acknowledge === 'invalid' ? `${response.ackId}-wrong-request` : response.ackId;
            socket.write(`${JSON.stringify({ id: response.id, capability, ack })}\n`, (error) => {
                if (error) finish(error); else finish(undefined, response.data);
            });
        });
        socket.on('error', (error) => finish(error));
        socket.on('close', () => finish(new Error('Peer broker closed before replying.')));
    });
}

async function brokerReady(socketPath: string, capability: string): Promise<boolean> {
    return new Promise((resolve, reject) => {
        const socket = createConnection(socketPath);
        let input = '';
        socket.on('connect', () => socket.write(`${JSON.stringify({ id: 'ready-flow', capability, ready: true })}\n`));
        socket.on('data', (chunk) => {
            input += chunk.toString('utf8');
            const newline = input.indexOf('\n');
            if (newline === -1) return;
            const response = JSON.parse(input.slice(0, newline)) as { id?: string; ok?: boolean; data?: { ready?: boolean } };
            socket.destroy();
            resolve(response.id === 'ready-flow' && response.ok === true && response.data?.ready === true);
        });
        socket.on('error', reject);
    });
}

describe('host peer collaboration flow', () => {
    it('rejects persisted non-string machine aliases', () => {
        const root = mkdtempSync(join(tmpdir(), 'muxr-peer-alias-'));
        writeFileSync(join(root, 'peers.json'), JSON.stringify({
            version: 1,
            revision: 0,
            preparations: [],
            relationships: [{
                relationshipId: 'relationship',
                machineId: 'machine',
                capabilities: [...DEFAULT_PEER_CAPABILITIES],
                direction: 'outbound',
                state: 'connected',
                relayUrl: 'ws://relay.test',
                machineAlias: 123,
                createdAt: 1,
                updatedAt: 1,
            }],
            receipts: [],
        }), { mode: 0o600 });
        expect(() => new PeerStore(root)).toThrow('unsupported peer schema');
    });
    it('prepares, authorizes, installs, executes one fresh prompt, rejects unsafe work, and revokes', async () => {
        const root = mkdtempSync(join(tmpdir(), 'muxr-peer-flow-'));
        const sourceKeys = machineCrypto();
        const targetKeys = machineCrypto();
        const sourceAuthority = new FakeAuthority();
        const targetAuthority = new FakeAuthority();
        let prompts = 0;
        const promptTexts: string[] = [];
        const session = {
            id: 'muxr-session-ios',
            cwd: '/work/app',
            path: 'internal-pane-path',
            agentName: 'iOS builder',
            created: new Date().toISOString(),
            modified: new Date().toISOString(),
            messageCount: 0,
            firstMessage: '',
            promptable: true,
            agentKind: 'pi',
        };
        let remoteSessions = [session];
        let controlWaits = false;
        let dropSessionsAfterPrompt = false;
        const pendingWaits: Array<(value: { status: string; detail: string }) => void> = [];
        const targetSource = {
            async list() { return remoteSessions; },
            async prompt(options: { text: string }) {
                prompts += 1;
                promptTexts.push(options.text);
                if (dropSessionsAfterPrompt) remoteSessions = [];
            },
            async paneRead() { return { text: 'build complete PWD=/Users/owner/private path:/private/tmp/work HOME=C:\\Users\\owner\\private pp_secret token=remote-secret-value', truncated: false }; },
            async status(sessionId: string) {
                return { sessionId, agentStatus: 'idle', isStreaming: false, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, cost: 0, usageLimits: { capturedAt: new Date().toISOString(), windows: [] } };
            },
            async agentWatch() { return { watching: true }; },
            async agentWait() {
                if (!controlWaits) return { status: 'done', detail: 'Agent is done' };
                return new Promise<{ status: string; detail: string }>((resolve) => pendingWaits.push(resolve));
            },
        } as unknown as SessionSource;
        let targetDispatch: ReturnType<typeof createRequestDispatcher>['dispatch'];
        let forcedRemoteError: Error | undefined;
        const sourceRuntime = new PeerRuntime({
            dataDir: join(root, 'source'),
            machineId: 'source-machine',
            machineName: 'Linux builder',
            platform: 'Linux',
            relayUrl: 'ws://source-relay.test',
            crypto: sourceKeys.adapter,
            authority: sourceAuthority,
            clientFactory: (relationship) => new class implements PeerClientTransport {
                async connect(): Promise<void> {}
                async request<T extends PeerClientRequestType>(type: T, params: RequestParams<T>, signal?: AbortSignal): Promise<RequestResult<T>> {
                    if (forcedRemoteError !== undefined && type === 'session.prompt') {
                        const error = forcedRemoteError;
                        forcedRemoteError = undefined;
                        throw error;
                    }
                    const dispatched = targetDispatch({ type, requestId: `peer-${Math.random()}`, params } as ClientRequest, relationship.peerDeviceId)
                        .then((response) => {
                            if (!response.ok) throw Object.assign(new Error(response.error), { code: response.code, fromHost: true });
                            return response.data as RequestResult<T>;
                        });
                    if (signal === undefined) return dispatched;
                    return Promise.race([
                        dispatched,
                        new Promise<RequestResult<T>>((_, reject) => signal.addEventListener('abort', () => reject(Object.assign(new Error('cancelled'), { name: 'AbortError', dispatched: true })), { once: true })),
                    ]);
                }
                close(): void {}
            }(),
        });
        const targetRuntime = new PeerRuntime({
            dataDir: join(root, 'target'),
            machineId: 'target-machine',
            machineName: 'Build Mac',
            platform: 'macOS',
            relayUrl: 'ws://target-relay.test',
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
                if (device?.kind !== 'peer') return undefined;
                return {
                    kind: 'peer',
                    ...(device.capabilities === undefined ? {} : { capabilities: device.capabilities }),
                    ...(device.allowedCwds === undefined ? {} : { allowedCwds: device.allowedCwds }),
                };
            },
        });
        targetDispatch = makeTargetDispatcher(targetRuntime).dispatch;
        const fresh = (operationId: string) => ({ operationId, notValidAfter: Date.now() + 60_000 });

        const prepared = await call(sourceRuntime, 'peer.prepare', {
            targetMachineId: 'target-machine',
            targetMachineSigningPublicKey: targetKeys.current().signingPublicKey,
            mutation: fresh('prepare'),
        });
        await expect(call(targetRuntime, 'peer.authorize', {
            descriptor: prepared.descriptor,
            capabilities: [...DEFAULT_PEER_CAPABILITIES],
            mutation: fresh('stale-relay-assertion'),
            targetRelayUrl: 'ws://stale-third-relay.test',
        })).rejects.toMatchObject({ code: 'peer-bundle-invalid' });
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
        expect(outbound.relayUrl).toBe('ws://target-relay.test');
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

        await sourceRuntime.store.putRelationship({
            ...outbound,
            relationshipId: 'revoked-old-build-mac',
            state: 'revoked',
            machineAlias: 'Build Mac',
        });
        const listed = await call(sourceRuntime, 'peer.remote.list', { relationshipId: installed.relationshipId });
        expect(listed).toEqual({ machineAlias: 'Build Mac', sessions: [{ sessionId: 'muxr-session-ios', agentName: 'iOS builder' }] });
        remoteSessions = [{ ...session, agentName: undefined, displayName: 'iOS builder' }] as unknown as typeof remoteSessions;
        await expect(call(sourceRuntime, 'peer.remote.list', { relationshipId: installed.relationshipId }))
            .resolves.toEqual({ machineAlias: 'Build Mac', sessions: [{ sessionId: 'muxr-session-ios', agentName: 'iOS builder' }] });
        remoteSessions = [session];
        const promptMutation = fresh('prompt-once');
        await call(sourceRuntime, 'peer.remote.prompt', {
            relationshipId: installed.relationshipId,
            sessionId: 'muxr-session-ios',
            text: 'Run the iOS build',
            mutation: promptMutation,
        });
        expect(prompts).toBe(1);
        expect(promptTexts).toEqual(['Peer message from Linux builder:\nRun the iOS build']);
        await expect(call(sourceRuntime, 'peer.remote.watch', {
            relationshipId: installed.relationshipId,
            sessionId: 'muxr-session-ios',
            timeoutMs: 5_000,
            mutation: fresh('watch-settlement'),
        })).resolves.toMatchObject({ settlement: { status: 'done', detail: 'Agent is done' } });

        controlWaits = true;
        let firstWatchSettled = false;
        const firstWatch = call(sourceRuntime, 'peer.remote.watch', {
            relationshipId: installed.relationshipId,
            sessionId: 'muxr-session-ios',
            until: ['done'],
            timeoutMs: 5_000,
            mutation: fresh('watch-first'),
        }).then((result) => { firstWatchSettled = true; return result; });
        const secondWatch = call(sourceRuntime, 'peer.remote.watch', {
            relationshipId: installed.relationshipId,
            sessionId: 'muxr-session-ios',
            until: ['blocked'],
            timeoutMs: 5_000,
            mutation: fresh('watch-second'),
        });
        await waitFor(() => pendingWaits.length >= 2, 'both directed watches');
        pendingWaits[1]!({ status: 'blocked', detail: 'Second watch settled' });
        await expect(secondWatch).resolves.toMatchObject({ settlement: { status: 'blocked' } });
        expect(firstWatchSettled).toBe(false);
        pendingWaits[0]!({ status: 'done', detail: 'First watch settled' });
        await expect(firstWatch).resolves.toMatchObject({ settlement: { status: 'done' } });
        controlWaits = false;

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
        await expect(targetDispatch({
            type: 'session.prompt', requestId: 'target-receipt-retry',
            params: { sessionId: 'muxr-session-ios', text: 'Peer message from Linux builder:\nRun the iOS build', peerMutation: promptMutation },
        }, authorized.peerDeviceId)).resolves.toMatchObject({ ok: true });
        expect(prompts).toBe(1);
        await call(sourceRuntime, 'peer.remote.prompt', {
            relationshipId: installed.relationshipId,
            sessionId: 'muxr-session-ios',
            text: 'Run the iOS build',
            mutation: fresh('prompt-retried-with-new-id'),
        });
        expect(prompts).toBe(1);
        expect(sourceRuntime.store.semanticMutations().find((entry) => entry.type === 'peer.remote.prompt' && 'text' in entry.params && entry.params.text === 'Run the iOS build')?.operationId)
            .toBe(promptMutation.operationId);

        forcedRemoteError = Object.assign(new Error('confirmed rejection'), { code: 'peer-forbidden' });
        await expect(call(sourceRuntime, 'peer.remote.prompt', {
            relationshipId: installed.relationshipId,
            sessionId: 'muxr-session-ios',
            text: 'Safe failure can retry',
            mutation: fresh('safe-failure'),
        })).rejects.toMatchObject({ code: 'peer-forbidden' });
        await expect(call(sourceRuntime, 'peer.remote.prompt', {
            relationshipId: installed.relationshipId,
            sessionId: 'muxr-session-ios',
            text: 'Safe failure can retry',
            mutation: fresh('safe-failure-new-id'),
        })).resolves.toMatchObject({ delivered: true });

        forcedRemoteError = Object.assign(new Error('outcome unresolved'), { code: 'peer-mutation-unresolved' });
        await expect(call(sourceRuntime, 'peer.remote.prompt', {
            relationshipId: installed.relationshipId,
            sessionId: 'muxr-session-ios',
            text: 'Ambiguous failure remains blocked',
            mutation: fresh('ambiguous-failure'),
        })).rejects.toMatchObject({ code: 'peer-mutation-unresolved' });
        await expect(call(sourceRuntime, 'peer.remote.prompt', {
            relationshipId: installed.relationshipId,
            sessionId: 'muxr-session-ios',
            text: 'Ambiguous failure remains blocked',
            mutation: fresh('ambiguous-failure-new-id'),
        })).rejects.toMatchObject({ code: 'peer-mutation-unresolved' });

        await expect(call(sourceRuntime, 'peer.remote.prompt', {
            relationshipId: installed.relationshipId,
            sessionId: 'muxr-session-ios',
            text: 'Too late',
            mutation: { operationId: 'expired', notValidAfter: Date.now() - 1 },
        })).rejects.toMatchObject({ code: 'peer-mutation-expired' });
        expect(prompts).toBe(2);

        await expect(targetDispatch({
            type: 'machine.shell', requestId: 'forbidden', params: { command: 'echo unsafe', cwd: '/tmp' },
        }, authorized.peerDeviceId)).resolves.toMatchObject({ ok: false, code: 'peer-forbidden' });

        const diagnostics = new HostDiagnosticsJournal(join(root, 'source'), 'test-version');
        const broker = new PeerBroker(join(root, 'source', 'broker.sock'), sourceRuntime, diagnostics);
        await broker.start();
        const access = broker.issueCapability();
        const cliFile = join(root, 'source', 'cli.json');
        const cliAccess = await broker.issuePersistentCapability(cliFile);
        expect(statSync(broker.socketPath).mode & 0o077).toBe(0);
        expect(statSync(cliFile).mode & 0o077).toBe(0);
        await expect(brokerReady(broker.socketPath, cliAccess.capability)).resolves.toBe(true);
        await expect(brokerReady(broker.socketPath, 'stale-capability')).resolves.toBe(false);
        expect(JSON.parse(readFileSync(cliFile, 'utf8'))).toEqual({ version: 1, ...cliAccess });
        const listedFromCli = await peerCli(cliFile, ['list']);
        expect(listedFromCli).toMatchObject({ code: 0, stderr: '' });
        expect(JSON.parse(listedFromCli.stdout)).toEqual({ machines: [{ machine: 'Build Mac', agents: [{ agent: 'iOS builder' }] }] });
        expect(listedFromCli.stdout).not.toMatch(/target-machine|muxr-session|internal-pane-path/);
        await expect(brokerCall(broker.socketPath, 'not-a-capability', { method: 'list' })).rejects.toThrow('capability rejected');
        await expect(brokerCall(broker.socketPath, access.capability, { method: 'unknown', text: 'must not become a prompt' })).rejects.toThrow('unknown peer broker method');
        const brokerList = await brokerCall(broker.socketPath, access.capability, { method: 'list', machine: 'Build Mac' });
        expect(brokerList).toEqual({ machines: [{ machine: 'Build Mac', agents: [{ agent: 'iOS builder' }] }] });
        await expect(brokerCall(broker.socketPath, access.capability, { method: 'list' })).resolves.toEqual(brokerList);
        expect(JSON.stringify(brokerList)).not.toMatch(/target-machine|muxr-session|internal-pane-path/);
        const spokenRead = await brokerCall(broker.socketPath, access.capability, { method: 'read', machine: 'Build Mac', agent: 'iOS builder' });
        expect(spokenRead).toMatchObject({ machine: 'Build Mac', agent: 'iOS builder', truncated: false });
        expect(JSON.stringify(spokenRead)).toContain('build complete');
        expect(JSON.stringify(spokenRead)).not.toMatch(/Users|\\\\Users|private\/tmp|pp_secret|remote-secret-value/);
        const causalPrompt = { method: 'prompt', machine: 'Build Mac', agent: 'iOS builder', text: 'Report build status' };
        await expect(brokerCall(broker.socketPath, access.capability, causalPrompt, false))
            .resolves.toEqual({ machine: 'Build Mac', agent: 'iOS builder', delivered: true });
        expect(prompts).toBe(3);
        const awaitingPluginAck = sourceRuntime.store.semanticMutations().find((entry) => entry.type === 'peer.remote.prompt'
            && 'text' in entry.params && entry.params.text === causalPrompt.text)!;
        expect(awaitingPluginAck.state).toBe('completed');
        await expect(brokerCall(broker.socketPath, access.capability, causalPrompt, 'invalid'))
            .resolves.toEqual({ machine: 'Build Mac', agent: 'iOS builder', delivered: true });
        expect(prompts).toBe(3);
        expect(sourceRuntime.store.semanticMutations().find((entry) => entry.operationId === awaitingPluginAck.operationId)).toMatchObject({ state: 'completed' });
        await expect(brokerCall(broker.socketPath, access.capability, causalPrompt))
            .resolves.toEqual({ machine: 'Build Mac', agent: 'iOS builder', delivered: true });
        expect(prompts).toBe(3);
        await waitFor(() => sourceRuntime.store.semanticMutations().find((entry) => entry.operationId === awaitingPluginAck.operationId)?.state === 'delivered', 'prompt delivery acknowledgement');
        expect(sourceRuntime.store.semanticMutations().find((entry) => entry.operationId === awaitingPluginAck.operationId)).toMatchObject({ state: 'delivered' });
        await expect(brokerCall(broker.socketPath, access.capability, { method: 'watch', machine: 'Build Mac', agent: 'iOS builder', timeoutMs: 5_000 }))
            .resolves.toMatchObject({ settlement: { status: 'done', detail: 'Agent is done' } });
        await waitFor(() => sourceRuntime.store.semanticMutations().some((entry) => entry.type === 'peer.remote.watch' && entry.state === 'delivered'), 'watch delivery acknowledgement');
        expect(sourceRuntime.store.semanticMutations()).toContainEqual(expect.objectContaining({ type: 'peer.remote.watch', state: 'delivered' }));
        remoteSessions = [session, { ...session, id: 'another-internal-session' }];
        const duplicateNames = await brokerCall(broker.socketPath, access.capability, { method: 'list', machine: 'Build Mac' }) as { machines: Array<{ agents: Array<{ agent: string }> }> };
        expect(duplicateNames.machines[0]!.agents).toEqual([{ agent: 'iOS builder' }, { agent: 'iOS builder' }]);
        await expect(brokerCall(broker.socketPath, access.capability, { method: 'read', machine: 'Build Mac', agent: 'iOS builder' }))
            .rejects.toThrow('More than one agent has that Agent Name');
        remoteSessions = [session];
        const afterRemoval = await brokerCall(broker.socketPath, access.capability, { method: 'list', machine: 'Build Mac' }) as { machines: Array<{ agents: Array<{ agent: string }> }> };
        expect(afterRemoval.machines[0]!.agents).toEqual([{ agent: 'iOS builder' }]);
        remoteSessions = [session, { ...session, id: 'another-internal-session' }];
        const afterReadd = await brokerCall(broker.socketPath, access.capability, { method: 'list', machine: 'Build Mac' }) as { machines: Array<{ agents: Array<{ agent: string }> }> };
        expect(afterReadd.machines[0]!.agents).toEqual([{ agent: 'iOS builder' }, { agent: 'iOS builder' }]);
        remoteSessions = [session];
        const promptedFromCli = await peerCli(cliFile, ['prompt', '--machine', 'Build Mac', '--agent', 'iOS builder', '--text', 'Report Xcode status']);
        expect(promptedFromCli).toMatchObject({ code: 0, stderr: '' });
        expect(JSON.parse(promptedFromCli.stdout)).toEqual({ machine: 'Build Mac', agent: 'iOS builder', delivered: true });
        expect(prompts).toBe(4);
        forcedRemoteError = Object.assign(new Error('Agent is not ready yet.'), { code: 'agent-not-ready' });
        await expect(brokerCall(broker.socketPath, access.capability, {
            method: 'prompt', machine: 'Build Mac', agent: 'iOS builder', text: 'Too early',
        })).rejects.toThrow('Agent is not ready yet.');
        dropSessionsAfterPrompt = true;
        await expect(call(sourceRuntime, 'peer.remote.prompt', {
            relationshipId: installed.relationshipId,
            sessionId: 'muxr-session-ios',
            text: 'Exit after queue',
            mutation: fresh('prompt-fast-exit'),
        })).resolves.toMatchObject({ agentName: 'iOS builder', delivered: true });
        expect(prompts).toBe(5);
        dropSessionsAfterPrompt = false;
        remoteSessions = [session];
        remoteSessions = [session, { ...session, id: 'another-internal-session' }];
        const { machineAlias: _machineAlias, ...outboundCopy } = sourceRuntime.store.relationship(installed.relationshipId)!;
        const duplicateMachine = {
            ...outboundCopy,
            relationshipId: 'second-build-mac',
            machineId: 'another-target-machine',
        };
        await sourceRuntime.store.putRelationship(duplicateMachine);
        const qualifiedMachines = await brokerCall(broker.socketPath, access.capability, { method: 'list' }) as { machines: Array<{ machine: string }> };
        expect(qualifiedMachines.machines.map((entry) => entry.machine).sort()).toEqual(['Build Mac', 'Build Mac (macOS)']);
        expect(JSON.stringify(qualifiedMachines)).not.toMatch(/another-target-machine|second-build-mac/);
        await expect(brokerCall(broker.socketPath, access.capability, { method: 'list', machine: 'Build Mac (macOS)' }))
            .resolves.toMatchObject({ machines: [expect.objectContaining({ machine: 'Build Mac (macOS)' })] });
        await sourceRuntime.store.putRelationship({ ...duplicateMachine, state: 'revoked' });
        remoteSessions = [session];
        controlWaits = true;
        const activeWaitIndex = pendingWaits.length;
        const activeWatch = brokerCall(broker.socketPath, access.capability, { method: 'watch', machine: 'Build Mac', agent: 'iOS builder', timeoutMs: 5_000 });
        await waitFor(() => pendingWaits.length > activeWaitIndex, 'active broker watch');
        broker.revokeCapability(access.capability);
        pendingWaits[activeWaitIndex]?.({ status: 'done', detail: 'cancelled wait cleanup' });
        await expect(activeWatch).rejects.toThrow(/closed|revoked|cancelled/i);
        controlWaits = false;
        await expect(brokerCall(broker.socketPath, access.capability, { method: 'list' })).rejects.toThrow('capability rejected');
        diagnostics.peerConnection('socket-open', 'ok', 4);
        diagnostics.peerConnection('liveness-proof', 'timeout', 20_000, 'liveness-timeout');
        diagnostics.request('peer.prepare', 'native', 'rejected', 1, 'peer-recovery-pending');
        diagnostics.agentReadiness('starting', false);
        diagnostics.agentReadiness('ready', true);
        diagnostics.agentReadiness('not-promptable', false, { kind: 'omp', lifecycle: 'idle', gate: 'not-interactive' });
        diagnostics.agentReadiness('not-promptable', false, { kind: 'w1EW:pH', lifecycle: 'idle', gate: 'unbound' });
        diagnostics.request('session.prompt', 'native', 'rejected', 8, 'agent-not-ready');
        diagnostics.request('session.start', 'native', 'rejected', 5300, 'start-launch-failed');
        diagnostics.agentLaunch('rejected', { kind: 'cursor', gate: 'unnamed' });
        diagnostics.agentLaunch('rejected', { kind: 'w1EW:pH', gate: 'no-session' });
        diagnostics.request('terminal.attach', 'native', 'rejected', 11, 'socket-timeout');
        for (let index = 0; index < 600; index += 1) diagnostics.request('herdr.tree', 'native', 'ok', 1);
        await broker.close();
        await diagnostics.flush();
        expect(existsSync(cliFile)).toBe(false);
        const diagnosticsPath = join(root, 'source', 'diagnostics.json');
        expect(statSync(diagnosticsPath).mode & 0o077).toBe(0);
        const diagnosticOutput = readFileSync(diagnosticsPath, 'utf8');
        const diagnosticEvents = (JSON.parse(diagnosticOutput) as { events: Array<{ event: string; operation?: string; request?: string; phase?: string; outcome?: string; code?: string; reason?: string; promptable?: boolean }> }).events;
        expect(diagnosticEvents).toContainEqual(expect.objectContaining({ event: 'peer.broker', operation: 'list', outcome: 'ok' }));
        expect(diagnosticEvents).toContainEqual(expect.objectContaining({ event: 'peer.broker', operation: 'prompt', outcome: 'ok' }));
        expect(diagnosticEvents).toContainEqual(expect.objectContaining({ event: 'peer.broker', operation: 'prompt', code: 'agent-not-ready' }));
        expect(diagnosticEvents).toContainEqual(expect.objectContaining({ event: 'peer.connection', phase: 'liveness-proof', outcome: 'timeout' }));
        expect(diagnosticEvents).toContainEqual(expect.objectContaining({ event: 'client.request', request: 'peer.prepare', code: 'peer-recovery-pending' }));
        expect(diagnosticEvents).toContainEqual(expect.objectContaining({ event: 'client.request', request: 'session.prompt', outcome: 'rejected', code: 'agent-not-ready' }));
        expect(diagnosticEvents).toContainEqual(expect.objectContaining({ event: 'client.request', request: 'session.start', outcome: 'rejected', code: 'start-launch-failed' }));
        expect(diagnosticEvents).toContainEqual(expect.objectContaining({ event: 'agent.launch', outcome: 'rejected', kind: 'cursor', gate: 'unnamed' }));
        expect(diagnosticEvents).toContainEqual(expect.objectContaining({ event: 'agent.launch', outcome: 'rejected', gate: 'no-session' }));
        expect(diagnosticEvents).toEqual(expect.arrayContaining([
            expect.objectContaining({ event: 'agent.readiness', reason: 'starting', promptable: false }),
            expect.objectContaining({ event: 'agent.readiness', reason: 'ready', promptable: true }),
            expect.objectContaining({ event: 'agent.readiness', reason: 'not-promptable', promptable: false }),
            expect.objectContaining({ event: 'agent.readiness', reason: 'not-promptable', kind: 'omp', lifecycle: 'idle', gate: 'not-interactive' }),
        ]));
        expect(diagnosticEvents).toContainEqual(expect.objectContaining({ event: 'client.request', request: 'terminal.attach', outcome: 'rejected', code: 'socket-timeout' }));
        expect(diagnosticEvents).not.toContainEqual(expect.objectContaining({ kind: 'w1EW:pH' }));
        expect(diagnosticEvents).not.toContainEqual(expect.objectContaining({ kind: 'w1ew:ph' }));
        expect(diagnosticEvents).not.toContainEqual(expect.objectContaining({ event: 'client.request', request: 'herdr.tree', outcome: 'ok' }));
        expect(diagnosticOutput).not.toMatch(/target-machine|muxr-session|internal-pane-path|Report Xcode status|machineId|sessionId|relationshipId|operationId/);
        let diagnosticNow = Date.parse('2026-08-26T00:00:00.000Z');
        const recencyDiagnostics = new HostDiagnosticsJournal(join(root, 'recency'), 'test-version', () => diagnosticNow);
        recencyDiagnostics.client('memory-only-device', 'native', true);
        diagnosticNow += 60 * 60_000;
        recencyDiagnostics.relay('open');
        await recencyDiagnostics.flush();
        const recencyState = JSON.parse(readFileSync(join(root, 'recency', 'diagnostics.json'), 'utf8')) as {
            current: { updatedAt: string; recentClients: { native: number } };
        };
        expect(recencyState.current).toMatchObject({ updatedAt: '2026-08-26T01:00:00.000Z', recentClients: { native: 0 } });

        // One peer cannot consume the global receipt store, and revocation bypasses receipts entirely.
        let capacityError: unknown;
        for (let index = 0; index < 64; index += 1) {
            try {
                await restartedTarget.store.putReceipt({
                    deviceId: authorized.peerDeviceId,
                    operationId: `exhaust-${index}`,
                    requestHash: `hash-${index}`,
                    notValidAfter: Date.now() + 60_000,
                    state: 'completed',
                    outcome: { ok: true, data: null },
                });
            } catch (error) {
                capacityError = error;
                break;
            }
        }
        expect(capacityError).toBeInstanceOf(Error);
        expect((capacityError as Error).message).toMatch(/this device/);

        const inboundRelationshipId = restartedTarget.store.list().peers[0]!.relationshipId;
        const putRelationship = restartedTarget.store.putRelationship.bind(restartedTarget.store);
        let crashAtRelationshipWrite = true;
        restartedTarget.store.putRelationship = async (relationship) => {
            if (crashAtRelationshipWrite && relationship.relationshipId === inboundRelationshipId && relationship.state === 'disconnecting') {
                crashAtRelationshipWrite = false;
                throw new Error('simulated crash after local crypto fence');
            }
            await putRelationship(relationship);
        };
        await expect(call(restartedTarget, 'peer.revoke', {
            relationshipId: inboundRelationshipId,
            peerDeviceId: authorized.peerDeviceId,
            mutation: fresh('revoke-target'),
        })).rejects.toThrow('simulated crash after local crypto fence');
        expect(targetKeys.current()).toMatchObject({
            devices: [],
            pendingRotation: { kind: 'peer-revoke-v1', revokedDeviceId: authorized.peerDeviceId },
        });
        expect(restartedTarget.store.relationship(inboundRelationshipId)).toMatchObject({ state: 'connected' });
        restartedTarget.close();

        const crashedTarget = new PeerRuntime({
            dataDir: join(root, 'target'),
            machineId: 'target-machine',
            machineName: 'Build Mac',
            platform: 'macOS',
            relayUrl: 'ws://relay.test',
            crypto: targetKeys.adapter,
            authority: targetAuthority,
        });
        await expect(call(crashedTarget, 'peer.prepare', {
            targetMachineId: 'another-target',
            targetMachineSigningPublicKey: sourceKeys.current().signingPublicKey,
            mutation: fresh('fenced-after-revocation-crash'),
        })).rejects.toMatchObject({ code: 'peer-recovery-pending' });
        targetAuthority.failRevokes = 1;
        await expect(crashedTarget.recover()).rejects.toThrow('simulated authority revocation outage');
        expect(targetKeys.current().pendingRotation).toMatchObject({ revokedDeviceId: authorized.peerDeviceId });
        expect(crashedTarget.store.relationship(inboundRelationshipId)).toMatchObject({ state: 'connected' });
        crashedTarget.retryRecovery();
        await waitFor(() => crashedTarget.store.relationship(inboundRelationshipId)?.state === 'revoked', 'crashed target revocation recovery');
        expect(targetAuthority.revoked.has(authorized.peerDeviceId)).toBe(true);
        expect(crashedTarget.store.relationship(inboundRelationshipId)).toMatchObject({ state: 'revoked' });
        expect(targetAuthority.rotations).toHaveLength(1);

        const putSourceRelationship = sourceRuntime.store.putRelationship.bind(sourceRuntime.store);
        let releaseSourceRevocation!: () => void;
        const sourceRevocationGate = new Promise<void>((resolve) => { releaseSourceRevocation = resolve; });
        let reportSourceRevocation!: () => void;
        const sourceRevocationStarted = new Promise<void>((resolve) => { reportSourceRevocation = resolve; });
        sourceRuntime.store.putRelationship = async (relationship) => {
            if (relationship.relationshipId === installed.relationshipId && relationship.state === 'revoked') {
                reportSourceRevocation();
                await sourceRevocationGate;
            }
            return putSourceRelationship(relationship);
        };
        const sourceRevocation = call(sourceRuntime, 'peer.revoke', {
            relationshipId: installed.relationshipId,
            peerDeviceId: authorized.peerDeviceId,
            mutation: fresh('revoke-source'),
        });
        await sourceRevocationStarted;
        await expect(call(sourceRuntime, 'peer.remote.list', {
            relationshipId: installed.relationshipId,
        })).rejects.toMatchObject({ code: 'peer-not-connected' });
        releaseSourceRevocation();
        await sourceRevocation;
        expect(sourceRuntime.store.list().peers).toContainEqual(expect.objectContaining({ relationshipId: installed.relationshipId, state: 'revoked', machineName: 'Build Mac' }));
    });

    it('keeps administration attached, fences mutations, and retries interrupted recovery on connectivity return', async () => {
        const root = mkdtempSync(join(tmpdir(), 'muxr-peer-recovery-'));
        const sourceKeys = machineCrypto();
        const targetKeys = machineCrypto();
        const source = new PeerRuntime({
            dataDir: join(root, 'source'), machineId: 'source', machineName: 'Linux', platform: 'Linux', relayUrl: 'ws://relay.test',
            crypto: sourceKeys.adapter, authority: new FakeAuthority(),
        });
        const authority = new FakeAuthority();
        authority.failGrantUploads = 1;
        let now = Date.now();
        const options = {
            dataDir: join(root, 'target'), machineId: 'target', machineName: 'Mac', platform: 'macOS', relayUrl: 'ws://relay.test',
            crypto: targetKeys.adapter, authority, now: () => now,
        };
        const target = new PeerRuntime(options);
        const prepared = await call(source, 'peer.prepare', {
            targetMachineId: 'target',
            targetMachineSigningPublicKey: targetKeys.current().signingPublicKey,
            descriptorExpiresAt: now + 1_000,
            mutation: { operationId: 'prepare-recovery', notValidAfter: now + 60_000 },
        });
        const authorize = {
            descriptor: prepared.descriptor,
            capabilities: [...DEFAULT_PEER_CAPABILITIES],
            relationshipId: 'rel_recovery',
            mutation: { operationId: 'authorize-recovery', notValidAfter: now + 60_000 },
        };
        await expect(call(target, 'peer.authorize', authorize)).rejects.toThrow('simulated grant upload interruption');
        expect(await call(target, 'peer.list', {})).toEqual({
            peers: [expect.objectContaining({ relationshipId: 'rel_recovery', state: 'repair-needed' })],
            revision: expect.any(Number),
        });
        expect(targetKeys.current().devices).toEqual([]);
        await expect(call(target, 'peer.revoke', {
            relationshipId: 'unrelated-missing-peer',
            mutation: { operationId: 'security-bypass', notValidAfter: now + 60_000 },
        })).resolves.toMatchObject({ state: 'already-revoked' });
        await expect(call(target, 'peer.prepare', {
            targetMachineId: 'another-target',
            targetMachineSigningPublicKey: targetKeys.current().signingPublicKey,
            mutation: { operationId: 'fenced', notValidAfter: now + 60_000 },
        })).rejects.toMatchObject({ code: 'peer-recovery-pending' });

        target.retryRecovery();
        await target.recover();
        expect(target.store.list().peers).toEqual([expect.objectContaining({ relationshipId: 'rel_recovery', state: 'connected' })]);
        expect(targetKeys.current().devices).toHaveLength(1);
        const recovered = await call(target, 'peer.authorize', authorize);
        expect(recovered.peerDeviceId).toBe(targetKeys.current().devices[0]!.deviceId);
        expect(targetKeys.current().devices).toHaveLength(1);

        const cancelledPrepared = await call(source, 'peer.prepare', {
            targetMachineId: 'target',
            targetMachineSigningPublicKey: targetKeys.current().signingPublicKey,
            descriptorExpiresAt: now + 1_000,
            mutation: { operationId: 'prepare-cancelled-recovery', notValidAfter: now + 60_000 },
        });
        authority.failGrantUploads = 1;
        await expect(call(target, 'peer.authorize', {
            descriptor: cancelledPrepared.descriptor,
            capabilities: [...DEFAULT_PEER_CAPABILITIES],
            relationshipId: 'rel_cancelled_recovery',
            mutation: { operationId: 'authorize-cancelled-recovery', notValidAfter: now + 60_000 },
        })).rejects.toThrow('simulated grant upload interruption');
        await expect(call(target, 'peer.revoke', {
            relationshipId: 'rel_cancelled_recovery',
            mutation: { operationId: 'revoke-cancelled-recovery', notValidAfter: now + 60_000 },
        })).resolves.toMatchObject({ state: 'revoked' });
        expect(target.store.pendingAuthorization()).toBeUndefined();
        await expect(call(target, 'peer.prepare', {
            targetMachineId: 'next-target',
            targetMachineSigningPublicKey: sourceKeys.current().signingPublicKey,
            mutation: { operationId: 'prepare-immediately-after-revoke', notValidAfter: now + 60_000 },
        })).resolves.toMatchObject({ preparationId: expect.stringMatching(/^prep_/) });
    });

    it('records redacted peer ingress receive, rejection, and decode boundaries', async () => {
        const machineId = 'private-target-machine';
        const peerDeviceId = 'private-peer-device';
        const ingressKey = randomBytes(32).toString('base64');
        const server = new WebSocketServer({ port: 0 });
        await new Promise<void>((resolve) => server.once('listening', resolve));
        const address = server.address();
        if (typeof address === 'string' || address === null) throw new Error('test websocket did not bind');
        let accept!: (socket: import('ws').WebSocket) => void;
        const accepted = new Promise<import('ws').WebSocket>((resolve) => { accept = resolve; });
        server.once('connection', accept);
        const root = mkdtempSync(join(tmpdir(), 'muxr-ingress-diagnostics-'));
        const diagnostics = new HostDiagnosticsJournal(root, 'test-version');
        let decoded!: () => void;
        const decodedFrame = new Promise<void>((resolve) => { decoded = resolve; });
        const link = connectToRelay({
            relayUrl: `ws://127.0.0.1:${address.port}`,
            machineId,
            hostedE2ee: {
                machineId, keyVersion: 1, dataKey: randomBytes(32).toString('base64'),
                ingressKeys: { [peerDeviceId]: ingressKey }, deviceKinds: { [peerDeviceId]: 'peer' },
            },
            onPeerIngress: (outcome) => diagnostics.peerIngress(outcome),
            onClientReject: (clientKey, kind, outcome) => diagnostics.clientReject(clientKey, kind, outcome),
            onClientFrame: () => decoded(),
        });
        const socket = await accepted;
        const header = {
            machineId, senderId: peerDeviceId, recipientId: machineId,
            channel: 'session' as const, streamId: 'machine', keyVersion: 1, at: Date.now(),
        };
        socket.send('null');
        socket.send(JSON.stringify({ header: { ...header, seq: 0 }, payload: 'invalid-ciphertext' } satisfies Envelope));
        const payload = sealV2(
            encodePayload({ type: 'client.hello', clientId: 'private-client' }),
            deriveV2Key(ingressKey, 'client->host'),
            header,
            newV2SenderState(),
        );
        socket.send(JSON.stringify({ header: { ...header, seq: v2EnvelopeSequence(payload) }, payload } satisfies Envelope));
        await decodedFrame;
        await diagnostics.flush();
        const output = readFileSync(join(root, 'diagnostics.json'), 'utf8');
        const state = JSON.parse(output) as { events: Array<{ event: string; outcome?: string }> };
        expect(state.events.filter((event) => event.event === 'peer.ingress').map((event) => event.outcome))
            .toEqual(['received', 'decrypt-rejected', 'received', 'decoded']);
        expect(state.events.filter((event) => event.event === 'client.reject').map((event) => event.outcome))
            .toEqual(['malformed', 'decrypt-rejected']);
        expect(output).not.toContain(machineId);
        expect(output).not.toContain(peerDeviceId);
        link.close();
        await new Promise<void>((resolve) => server.close(() => resolve()));
    });

    it('requires a fresh correlated host result before releasing a peer mutation', async () => {
        const machine = machineCrypto().current();
        const peerKey = generateKeyPair();
        const ingressKey = randomBytes(32).toString('base64');
        const peerDataKey = randomBytes(32).toString('base64');
        const deviceId = 'peer-live-device';
        const sealedGrant = createDeviceGrant({
            machineId: 'target-live',
            machineSigningSecretKey: machine.signingSecretKey,
            machineKey: { publicKey: machine.boxPublicKey, secretKey: machine.boxSecretKey },
            deviceId,
            devicePublicKey: peerKey.publicKey,
            dataKey: peerDataKey,
            ingressKey,
            keyVersion: 1,
            expiresAt: Date.now() + 60_000,
            deviceKind: 'peer',
            capabilities: [...DEFAULT_PEER_CAPABILITIES],
        });
        expect(() => new NodePeerClient({
            relayUrl: 'ws://127.0.0.1',
            machineId: 'different-target',
            credential: 'peer-credential',
            peerDeviceId: deviceId,
            peerKey,
            pinnedMachineSigningPublicKey: machine.signingPublicKey,
            sealedGrant,
        })).toThrow('peer grant has the wrong target machine');

        let releaseDisposedRefresh!: () => void;
        const disposedRefreshGate = new Promise<void>((resolve) => { releaseDisposedRefresh = resolve; });
        let reportDisposedRefresh!: () => void;
        const disposedRefreshStarted = new Promise<void>((resolve) => { reportDisposedRefresh = resolve; });
        let disposedFetchCalls = 0;
        const disposedFetch = (async () => {
            disposedFetchCalls += 1;
            reportDisposedRefresh();
            await disposedRefreshGate;
            return new Response(JSON.stringify({ grant: JSON.stringify(sealedGrant) }), {
                status: 200,
                headers: { 'content-type': 'application/json' },
            });
        }) as typeof fetch;
        const disposedClient = new NodePeerClient({
            relayUrl: 'ws://127.0.0.1:1',
            machineId: 'target-live',
            credential: 'peer-credential',
            peerDeviceId: deviceId,
            peerKey,
            pinnedMachineSigningPublicKey: machine.signingPublicKey,
            sealedGrant,
            fetch: disposedFetch,
        });
        const disposedRequest = expect(disposedClient.request('session.prompt', {
            sessionId: 'private-session',
            text: 'must not reconnect after local revocation',
            peerMutation: { operationId: 'disposed-client-prompt', notValidAfter: Date.now() + 60_000 },
        })).rejects.toMatchObject({ name: 'AbortError' });
        await disposedRefreshStarted;
        disposedClient.close();
        releaseDisposedRefresh();
        await disposedRequest;
        await expect(disposedClient.connect()).rejects.toMatchObject({ name: 'AbortError' });
        expect(disposedFetchCalls).toBe(1);

        const sourceRelay = new WebSocketServer({ port: 0 });
        let sourceRelayConnections = 0;
        sourceRelay.on('connection', () => { sourceRelayConnections += 1; });
        await new Promise<void>((resolve) => sourceRelay.once('listening', resolve));
        const staleRelay = new WebSocketServer({ port: 0 });
        let staleRelayConnections = 0;
        staleRelay.on('connection', () => { staleRelayConnections += 1; });
        await new Promise<void>((resolve) => staleRelay.once('listening', resolve));
        const server = new WebSocketServer({ port: 0 });
        await new Promise<void>((resolve) => server.once('listening', resolve));
        const address = server.address();
        if (typeof address === 'string' || address === null) throw new Error('test websocket did not bind');
        const relayUrl = `ws://127.0.0.1:${address.port}`;
        let releaseChallenge!: () => void;
        const challengeGate = new Promise<void>((resolve) => { releaseChallenge = resolve; });
        let sawChallenge!: () => void;
        const challengeSeen = new Promise<void>((resolve) => { sawChallenge = resolve; });
        let sawWatch!: () => void;
        const watchSeen = new Promise<void>((resolve) => { sawWatch = resolve; });
        let releaseWatch!: () => void;
        const watchGate = new Promise<void>((resolve) => { releaseWatch = resolve; });
        const watchOperationIds: string[] = [];
        const promptOperationIds: string[] = [];
        const executedPrompts = new Set<string>();
        let promptExecutions = 0;
        let answerLiveness = true;
        const hostCrypto = new HostV2Crypto({
            machineId: 'target-live', keyVersion: 1, dataKey: machine.dataKey,
            ingressKeys: { [deviceId]: ingressKey }, deviceDataKeys: { [deviceId]: peerDataKey },
        });
        server.on('connection', (socket) => {
            const send = (frame: object) => {
                const payload = hostCrypto.seal('session', 'machine', JSON.stringify(frame), deviceId);
                socket.send(JSON.stringify({
                    header: {
                        machineId: 'target-live', senderId: 'target-live', recipientId: deviceId,
                        channel: 'session', streamId: 'machine', keyVersion: 1,
                        seq: v2EnvelopeSequence(payload), at: Date.now(),
                    },
                    payload,
                } satisfies Envelope));
            };
            send({ type: 'result', requestId: 'captured-before-restart', ok: true, data: [] });
            const replay = newV2ReplayTracker();
            socket.on('message', (raw) => {
                const envelope = JSON.parse(String(raw)) as Envelope;
                const plaintext = openV2(envelope.payload, deriveV2Key(ingressKey, 'client->host'), {
                    machineId: 'target-live', senderId: deviceId, recipientId: 'target-live',
                    channel: 'session', streamId: envelope.header.streamId!, keyVersion: 1,
                }, replay);
                const frame = decodePayload<ClientRequest>(plaintext);
                if (frame.type === 'machines.list') {
                    sawChallenge();
                    if (answerLiveness) void challengeGate.then(() => send({ type: 'result', requestId: frame.requestId, ok: true, data: [] }));
                } else if (frame.type === 'agent.watch') {
                    watchOperationIds.push(frame.params.peerMutation!.operationId);
                    sawWatch();
                    void watchGate.then(() => {
                        if (watchOperationIds.length === 1) socket.close();
                        else send({
                            type: 'result', requestId: frame.requestId, ok: true,
                            data: { watching: true, settlement: { status: 'done', detail: 'directed completion' } },
                        });
                    });
                } else if (frame.type === 'session.prompt') {
                    const operationId = frame.params.peerMutation!.operationId;
                    promptOperationIds.push(operationId);
                    if (!executedPrompts.has(operationId)) {
                        executedPrompts.add(operationId);
                        promptExecutions += 1;
                    }
                    if (promptOperationIds.length === 1) socket.close();
                    else send({ type: 'result', requestId: frame.requestId, ok: true, data: null });
                }
            });
        });
        const controlOrigins: string[] = [];
        const fakeFetch = (async (input: string | URL | Request) => {
            const url = new URL(String(input));
            controlOrigins.push(url.origin);
            const path = url.pathname;
            const body = path === '/v1/ws-tickets' ? { ticket: 'fresh-ticket' } : { grant: JSON.stringify(sealedGrant) };
            return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
        }) as typeof fetch;
        const originalFetch = globalThis.fetch;
        globalThis.fetch = fakeFetch;
        const connectionDiagnostics: PeerConnectionDiagnostic[] = [];
        const client = new NodePeerClient({
            relayUrl,
            machineId: 'target-live',
            credential: 'peer-credential',
            peerDeviceId: deviceId,
            peerKey,
            pinnedMachineSigningPublicKey: machine.signingPublicKey,
            sealedGrant,
            requestTimeoutMs: 2_000,
            fetch: fakeFetch,
            onConnectionDiagnostic: (event) => connectionDiagnostics.push(event),
        });
        let silentClient: NodePeerClient | undefined;
        let connected = false;
        try {
            const connecting = client.connect().then(() => { connected = true; });
            await challengeSeen;
            await new Promise((resolve) => setTimeout(resolve, 0));
            expect(connected).toBe(false);
            releaseChallenge();
            await connecting;
            expect(connected).toBe(true);
            let watchSettled = false;
            const watching = client.request('agent.watch', {
                sessionId: 'private-session',
                timeoutMs: 1_000,
                peerMutation: { operationId: 'directed-watch', notValidAfter: Date.now() + 60_000 },
            }).then((result) => { watchSettled = true; return result; });
            await watchSeen;
            expect(watchSettled).toBe(false);
            releaseWatch();
            await expect(watching).resolves.toMatchObject({ settlement: { detail: 'directed completion' } });
            expect(watchOperationIds).toEqual(['directed-watch', 'directed-watch']);
            await expect(client.request('session.prompt', {
                sessionId: 'private-session',
                text: 'retry this exact semantic prompt',
                peerMutation: { operationId: 'durable-buffered-prompt', notValidAfter: Date.now() + 5_000 },
            })).resolves.toBeNull();
            expect(promptOperationIds).toEqual(['durable-buffered-prompt', 'durable-buffered-prompt']);
            expect(promptExecutions).toBe(1);
            expect(sourceRelayConnections).toBe(0);
            expect(staleRelayConnections).toBe(0);
            expect(new Set(controlOrigins)).toEqual(new Set([new URL(relayControlUrl(relayUrl)).origin]));
            expect(connectionDiagnostics).toEqual(expect.arrayContaining([
                expect.objectContaining({ phase: 'grant-refresh', outcome: 'ok' }),
                expect.objectContaining({ phase: 'ticket-issue', outcome: 'ok' }),
                expect.objectContaining({ phase: 'socket-open', outcome: 'ok' }),
                expect.objectContaining({ phase: 'liveness-proof', outcome: 'ok' }),
            ]));

            answerLiveness = false;
            const timeoutDiagnostics: PeerConnectionDiagnostic[] = [];
            silentClient = new NodePeerClient({
                relayUrl,
                machineId: 'target-live',
                credential: 'peer-credential',
                peerDeviceId: deviceId,
                peerKey,
                pinnedMachineSigningPublicKey: machine.signingPublicKey,
                sealedGrant,
                requestTimeoutMs: 50,
                fetch: fakeFetch,
                onConnectionDiagnostic: (event) => timeoutDiagnostics.push(event),
            });
            await expect(silentClient.connect()).rejects.toThrow('peer target did not prove it was live');
            expect(timeoutDiagnostics.at(-1)).toMatchObject({ phase: 'liveness-proof', outcome: 'timeout', code: 'liveness-timeout' });
        } finally {
            client.close();
            silentClient?.close();
            globalThis.fetch = originalFetch;
            await Promise.all([
                new Promise<void>((resolve) => server.close(() => resolve())),
                new Promise<void>((resolve) => sourceRelay.close(() => resolve())),
                new Promise<void>((resolve) => staleRelay.close(() => resolve())),
            ]);
        }
    });

    it('scopes self-host peer authority calls to the target machine', async () => {
        const calls: string[] = [];
        const peerPublicKey = generateKeyPair().publicKey;
        let lists = 0;
        const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
            const url = new URL(String(input));
            const method = init?.method ?? 'GET';
            calls.push(`${method} ${url.pathname}${url.search}`);
            let body: Record<string, unknown> = { ok: true };
            if (url.pathname === '/v1/selfhost/peers' && method === 'GET') {
                body = { peers: lists++ === 0 ? [] : [{ deviceId: 'peer-device', publicKey: peerPublicKey }] };
            } else if (url.pathname === '/v1/selfhost/peers' && method === 'POST') {
                body = { device_id: 'peer-device', device_credential: 'peer-credential' };
            } else if (url.pathname.endsWith('/rotate')) {
                body = { device_credential: 'rotated-credential' };
            }
            return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
        }) as typeof fetch;
        const authority = new HttpPeerAuthority({
            kind: 'selfhost', controlUrl: 'https://relay.test', machineId: 'target-machine', credential: 'owner-secret', fetch: fetchImpl,
        });
        const input = {
            peerPublicKey,
            sourceMachineId: 'source-machine',
            sourceName: 'Linux builder',
            capabilities: [...DEFAULT_PEER_CAPABILITIES],
            credentialExpiresAt: Date.now() + 60_000,
            refreshAfter: Date.now() + 30_000,
        };
        await authority.issuePeer(input);
        await authority.issuePeer(input);
        await authority.uploadGrant('peer-device', 'sealed-peer-grant', 2);
        await authority.revokePeer('peer-device');
        await authority.publishRotation(3, [{ deviceId: 'peer-device', devicePublicKey: peerPublicKey, grant: 'rotated-grant' }]);

        expect(calls).toEqual([
            'GET /v1/selfhost/peers?machine=target-machine',
            'POST /v1/selfhost/peers?machine=target-machine',
            'GET /v1/selfhost/peers?machine=target-machine',
            'POST /v1/selfhost/peers/peer-device/rotate?machine=target-machine',
            'POST /v1/selfhost/peers/peer-device/grant?machine=target-machine',
            'DELETE /v1/selfhost/peers/peer-device?machine=target-machine',
            'POST /v1/selfhost/machines/target-machine/grants',
        ]);
    });

    it('uses deployed hosted pair-session, device revoke, and rotation APIs', async () => {
        const calls: Array<{ path: string; method: string; authorization?: string }> = [];
        const peerPublicKey = generateKeyPair().publicKey;
        const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
            const url = new URL(String(input));
            const method = init?.method ?? 'GET';
            const headers = new Headers(init?.headers);
            calls.push({ path: url.pathname, method, ...(headers.get('authorization') === null ? {} : { authorization: headers.get('authorization')! }) });
            let body: Record<string, unknown> = { ok: true };
            if (url.pathname === '/v1/pair-sessions/old-pair' && method === 'GET') {
                body = { state: 'claimed', device: { id: 'old-device', public_key: peerPublicKey } };
            } else if (url.pathname === '/v1/pair-sessions' && method === 'POST') {
                body = { pair_id: 'new-pair' };
            } else if (url.pathname === '/v1/pair-sessions/new-pair/claim') {
                body = { access_token: 'peer-credential', device: { id: 'new-device' } };
            }
            return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
        }) as typeof fetch;
        const authority = new HttpPeerAuthority({
            kind: 'hosted', controlUrl: 'https://control.test', machineId: 'target-machine', credential: 'machine-credential', fetch: fetchImpl,
        });
        const checkpoints: string[] = [];
        const issued = await authority.issuePeer({
            peerPublicKey,
            sourceMachineId: 'source-machine',
            sourceName: 'Linux builder',
            capabilities: [...DEFAULT_PEER_CAPABILITIES],
            credentialExpiresAt: Date.now() + 60_000,
            refreshAfter: Date.now() + 30_000,
        }, {
            recovery: { pairId: 'old-pair', controlClaim: 'old-claim' },
            checkpoint: async (recovery) => { checkpoints.push(recovery.pairId); },
        });
        await authority.uploadGrant(issued.peerDeviceId, 'sealed-peer-grant', 2, issued.recovery);
        await authority.revokePeer(issued.peerDeviceId);
        await authority.publishRotation(3, [{ devicePublicKey: peerPublicKey, grant: 'rotated-grant' }]);

        expect(issued).toMatchObject({ peerDeviceId: 'new-device', credential: 'peer-credential', recovery: { pairId: 'new-pair' } });
        expect(checkpoints).toEqual(['new-pair']);
        expect(calls.map((call) => `${call.method} ${call.path}`)).toEqual([
            'GET /v1/pair-sessions/old-pair',
            'POST /v1/devices/old-device/revoke',
            'POST /v1/pair-sessions',
            'POST /v1/pair-sessions/new-pair/claim',
            'POST /v1/pair-sessions/new-pair/grant',
            'POST /v1/devices/new-device/revoke',
            'POST /v1/machines/target-machine/keys/rotate',
        ]);
        expect(calls.find((call) => call.path.endsWith('/claim'))?.authorization).toBeUndefined();
        expect(calls.some((call) => call.path.includes('/peers'))).toBe(false);
    });
});
