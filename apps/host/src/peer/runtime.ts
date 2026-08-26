import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import {
    DEFAULT_PEER_CAPABILITIES,
    isPeerCapabilities,
    peerCapabilityForRequest,
    relayControlUrl,
    type ClientRequest,
    type PeerCapability,
    type PeerClientRequest,
    type PeerRelationship,
    type PeerRequestResult,
    type RequestResponse,
} from '@muxr/contract';
import {
    createDeviceGrant,
    createSignedPeerDescriptor,
    generateKeyPair,
    openPeerInstallBundle,
    sealPeerInstallBundle,
    verifyDeviceGrant,
    verifySignedPeerDescriptor,
    type PeerInstallBundlePayload,
} from '@muxr/crypto';
import type { PeerAuthority } from './authority.js';
import type { PeerClientTransport, PeerConnectionDiagnostic } from './client.js';
import { OutboundPeerService } from './outboundPeerService.js';
import { PeerReceiptExecutor } from './receiptExecutor.js';
import { PeerStore, type StoredPendingAuthorization, type StoredPeerRelationship } from './store.js';
import type { MachineCryptoAdapter, MachineCryptoState, MachineDeviceRecord, MachinePendingRotation } from './types.js';

const PEER_CREDENTIAL_EXPIRES_AT = Date.UTC(9999, 11, 31, 23, 59, 59, 999);

export interface PeerDeviceContext {
    kind: 'native' | 'browser' | 'peer';
    capabilities?: readonly PeerCapability[];
    allowedCwds?: readonly string[];
}

export interface PeerRuntimeOptions {
    dataDir: string;
    machineId: string;
    machineName: string;
    platform: string;
    relayUrl: string;
    crypto: MachineCryptoAdapter;
    authority: PeerAuthority;
    now?: () => number;
    clientFactory?: (relationship: StoredPeerRelationship) => PeerClientTransport;
    onConnectionDiagnostic?: (event: PeerConnectionDiagnostic) => void;
}

function operationError(message: string, code: string): Error {
    return Object.assign(new Error(message), { code });
}

type RemotePeerRequest = Extract<PeerClientRequest, { type: `peer.remote.${string}` }>;

function isRemotePeerRequest(request: PeerClientRequest): request is RemotePeerRequest {
    return request.type === 'peer.remote.list' || request.type === 'peer.remote.read'
        || request.type === 'peer.remote.status' || request.type === 'peer.remote.watch'
        || request.type === 'peer.remote.prompt' || request.type === 'peer.remote.start';
}

function publicRelationship(entry: StoredPeerRelationship): PeerRelationship {
    return {
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
    };
}

export class PeerRuntime {
    readonly store: PeerStore;
    private readonly outboundService: OutboundPeerService;
    private readonly receipts: PeerReceiptExecutor;
    private cryptoQueue = Promise.resolve();
    private readonly now: () => number;
    private recoveryPending: boolean;
    private recoveryPromise: Promise<void> | undefined;
    private recoveryTimer: ReturnType<typeof setTimeout> | undefined;
    private recoveryAttempts = 0;

    constructor(private readonly options: PeerRuntimeOptions) {
        this.store = new PeerStore(options.dataDir);
        this.now = options.now ?? Date.now;
        this.receipts = new PeerReceiptExecutor(this.store, this.now);
        this.outboundService = new OutboundPeerService({
            store: this.store,
            now: this.now,
            sourceMachineName: options.machineName,
            ...(options.clientFactory === undefined ? {} : { clientFactory: options.clientFactory }),
            ...(options.onConnectionDiagnostic === undefined ? {} : { onConnectionDiagnostic: options.onConnectionDiagnostic }),
        });
        this.recoveryPending = this.hasRecoveryWork();
    }

    async recover(): Promise<void> {
        if (this.recoveryPromise !== undefined) return this.recoveryPromise;
        if (this.recoveryTimer !== undefined) clearTimeout(this.recoveryTimer);
        this.recoveryTimer = undefined;
        this.recoveryPending = this.hasRecoveryWork();
        const recovery = (async () => {
            const rotation = this.options.crypto.get().pendingRotation;
            if (rotation?.kind === 'peer-revoke-v1') await this.withCryptoLock(() => this.finishPeerRevocation(rotation));
            const authorization = this.store.pendingAuthorization();
            if (authorization !== undefined) await this.withCryptoLock(() => this.finishAuthorization(authorization));
            await this.withCryptoLock(() => this.repairOrphanDevices());
            this.outboundService.recoverOutstanding();
            this.recoveryPending = false;
            this.recoveryAttempts = 0;
        })();
        this.recoveryPromise = recovery;
        try { await recovery; }
        catch (error) {
            this.recoveryPending = this.hasRecoveryWork();
            if (this.recoveryPending) this.scheduleRecovery();
            throw error;
        } finally {
            if (this.recoveryPromise === recovery) this.recoveryPromise = undefined;
        }
    }

    retryRecovery(): void {
        this.recoveryAttempts = 0;
        if (this.recoveryTimer !== undefined) clearTimeout(this.recoveryTimer);
        this.recoveryTimer = undefined;
        void this.recover().catch(() => undefined);
    }

    close(): void {
        if (this.recoveryTimer !== undefined) clearTimeout(this.recoveryTimer);
        this.outboundService.close();
    }

    async handle(request: PeerClientRequest, authenticatedDeviceId: string, signal?: AbortSignal): Promise<unknown> {
        if (request.type === 'peer.list') return this.store.list();
        const mutates = request.type === 'peer.prepare' || request.type === 'peer.authorize' || request.type === 'peer.install'
            || request.type === 'peer.remote.watch' || request.type === 'peer.remote.prompt'
            || request.type === 'peer.remote.start';
        if (mutates) this.assertRecoveryReady();
        try {
            if (isRemotePeerRequest(request)) return await this.outboundService.handle(request, signal);
            if (request.type === 'peer.authorize') return await this.withCryptoLock(() => this.authorize(request.params));
            // Revocation is authenticated, destructive only to access, and idempotent. It must never
            // compete with attacker-controlled mutation receipts for admission.
            if (request.type === 'peer.revoke') return await this.withCryptoLock(() => this.revoke(request.params));
            const mutation = request.params.mutation;
            return await this.receipts.execute(`control:${authenticatedDeviceId}`, request.type, mutation, request.params, async () => {
                switch (request.type) {
                    case 'peer.prepare': return this.prepare(request.params);
                    case 'peer.install': return this.install(request.params);
                    default: throw operationError('unknown peer request', 'host-contract-mismatch');
                }
            });
        } catch (error) {
            this.noteRecoveryWork();
            throw error;
        }
    }

    async dispatchIncoming(
        request: ClientRequest,
        deviceId: string,
        context: PeerDeviceContext,
        execute: () => Promise<RequestResponse>,
    ): Promise<RequestResponse> {
        const capability = peerCapabilityForRequest(request.type);
        if (context.kind !== 'peer' || capability === undefined || !context.capabilities?.includes(capability)) {
            return { type: 'result', requestId: request.requestId, ok: false, error: 'peer grant forbids this request', code: 'peer-forbidden' };
        }
        if (request.type === 'session.start' && (request.params.parentSessionId !== undefined
            || request.params.createCwd !== undefined || request.params.worktree !== undefined || request.params.kinds !== undefined
            || !this.startAllowed(request.params.cwd, context.allowedCwds))) {
            return { type: 'result', requestId: request.requestId, ok: false, error: 'peer start is outside its approved surface', code: 'peer-forbidden' };
        }
        if (request.type !== 'session.prompt' && request.type !== 'session.start' && request.type !== 'agent.watch') {
            return execute();
        }
        const mutation = request.params.peerMutation;
        if (mutation === undefined) {
            return { type: 'result', requestId: request.requestId, ok: false, error: 'peer mutation metadata is required', code: 'peer-mutation-required' };
        }
        try {
            this.assertRecoveryReady();
            const outcome = await this.receipts.execute(deviceId, request.type, mutation, request.params, async () => {
                const response = await execute();
                return response.ok
                    ? { ok: true as const, data: response.data }
                    : { ok: false as const, error: response.error, ...(response.code === undefined ? {} : { code: response.code }) };
            });
            return outcome.ok
                ? { type: 'result', requestId: request.requestId, ok: true, data: outcome.data }
                : { type: 'result', requestId: request.requestId, ok: false, error: outcome.error, ...(outcome.code === undefined ? {} : { code: outcome.code }) };
        } catch (error) {
            this.noteRecoveryWork();
            return {
                type: 'result', requestId: request.requestId, ok: false,
                error: error instanceof Error ? error.message : String(error),
                ...((error as { code?: unknown }).code === undefined ? {} : { code: String((error as { code: unknown }).code) }),
            };
        }
    }

    private async prepare(params: Extract<PeerClientRequest, { type: 'peer.prepare' }>['params']): Promise<PeerRequestResult<'peer.prepare'>> {
        const crypto = this.readyCrypto();
        const now = this.now();
        const expiresAt = params.descriptorExpiresAt ?? now + 5 * 60_000;
        const key = generateKeyPair();
        const preparationId = `prep_${randomUUID()}`;
        const descriptor = createSignedPeerDescriptor({
            sourceMachineId: this.options.machineId,
            sourceMachineSigningSecretKey: crypto.signingSecretKey,
            targetMachineId: params.targetMachineId,
            targetMachineSigningPublicKey: params.targetMachineSigningPublicKey,
            peerPublicKey: key.publicKey,
            preparedAt: now,
            expiresAt,
            nonce: randomBytes(24).toString('base64url'),
            sourceName: params.sourceName?.trim() || this.options.machineName,
            sourcePlatform: params.sourcePlatform?.trim() || this.options.platform,
        });
        await this.store.putPreparation({
            preparationId,
            targetMachineId: params.targetMachineId,
            targetMachineSigningPublicKey: params.targetMachineSigningPublicKey,
            key,
            descriptor,
            expiresAt,
        });
        return { preparationId, descriptor, expiresAt };
    }

    private async authorize(params: Extract<PeerClientRequest, { type: 'peer.authorize' }>['params']): Promise<PeerRequestResult<'peer.authorize'>> {
        const descriptorHash = createHash('sha256').update(JSON.stringify(params.descriptor)).digest('base64url');
        const completed = this.store.authorization(descriptorHash);
        if (completed !== undefined) {
            if (params.relationshipId !== undefined && params.relationshipId !== completed.relationshipId) {
                throw operationError('peer descriptor was reused with a different relationship', 'peer-operation-conflict');
            }
            const pending = this.store.pendingAuthorization();
            if (completed.state === 'connected') {
                if (pending?.descriptorHash === descriptorHash) await this.store.putPendingAuthorization(undefined);
                return this.authorizationResult(completed);
            }
            if (pending === undefined) throw operationError('peer authorization recovery journal is missing', 'peer-operation-uncertain');
            return this.finishAuthorization(pending);
        }
        const pending = this.store.pendingAuthorization();
        if (pending !== undefined) {
            if (pending.descriptorHash === descriptorHash) return this.finishAuthorization(pending);
            await this.finishAuthorization(pending);
        }
        const crypto = this.readyCrypto();
        const claims = verifySignedPeerDescriptor(params.descriptor, {
            targetMachineId: this.options.machineId,
            targetMachineSigningPublicKey: crypto.signingPublicKey,
            now: this.now(),
        });
        if (!isPeerCapabilities(params.capabilities)) throw operationError('invalid peer capabilities', 'peer-invalid-capabilities');
        const allowedCwds = this.validateStartDirectories(params.capabilities, params.allowedCwds);
        const targetRelayUrl = params.targetRelayUrl?.trim() || this.options.relayUrl;
        try { relayControlUrl(targetRelayUrl); }
        catch { throw operationError('invalid target relay endpoint', 'peer-bundle-invalid'); }
        if (crypto.devices.some((device) => device.devicePublicKey === claims.peerPublicKey)) {
            await this.repairOrphanDevices();
        }
        const current = this.readyCrypto();
        if (current.devices.some((device) => device.devicePublicKey === claims.peerPublicKey)) {
            throw operationError('peer key is already authorized', 'peer-already-authorized');
        }
        if (current.devices.filter((device) => device.kind === 'peer').length >= 16) {
            throw operationError('peer limit reached for this personal fleet', 'peer-limit');
        }
        const relationshipId = params.relationshipId ?? `rel_${descriptorHash.slice(0, 32)}`;
        if (this.store.relationship(relationshipId) !== undefined) {
            throw operationError('peer relationship id is already in use', 'peer-operation-conflict');
        }
        const authorization: StoredPendingAuthorization = {
            version: 1,
            relationshipId,
            descriptor: params.descriptor,
            descriptorHash,
            sourceMachineId: claims.sourceMachineId,
            ...(claims.sourceName === undefined ? {} : { sourceName: claims.sourceName.trim().slice(0, 120) }),
            ...(claims.sourcePlatform === undefined ? {} : { sourcePlatform: claims.sourcePlatform }),
            peerPublicKey: claims.peerPublicKey,
            capabilities: [...params.capabilities],
            ...(allowedCwds === undefined ? {} : { allowedCwds }),
            relayUrl: targetRelayUrl,
            createdAt: this.now(),
        };
        await this.store.putPendingAuthorization(authorization);
        return this.finishAuthorization(authorization);
    }

    private async finishAuthorization(initial: StoredPendingAuthorization): Promise<PeerRequestResult<'peer.authorize'>> {
        let pending = this.store.pendingAuthorization() ?? initial;
        if (pending.descriptorHash !== initial.descriptorHash) throw operationError('another peer authorization is pending', 'peer-operation-conflict');
        const crypto = this.readyCrypto();
        if (pending.issued === undefined) {
            const issued = await this.options.authority.issuePeer({
                peerPublicKey: pending.peerPublicKey,
                sourceMachineId: pending.sourceMachineId,
                sourceName: pending.sourceName || 'Peer computer',
                capabilities: [...pending.capabilities],
                credentialExpiresAt: PEER_CREDENTIAL_EXPIRES_AT,
                refreshAfter: PEER_CREDENTIAL_EXPIRES_AT,
            }, {
                ...(pending.authorityRecovery === undefined ? {} : { recovery: pending.authorityRecovery }),
                checkpoint: async (authorityRecovery) => {
                    pending = { ...pending, authorityRecovery };
                    await this.store.putPendingAuthorization(pending);
                },
            });
            pending = {
                ...pending,
                ...(issued.recovery === undefined ? {} : { authorityRecovery: issued.recovery }),
                issued: {
                    peerDeviceId: issued.peerDeviceId,
                    credential: issued.credential,
                    authority: issued.authority,
                    ...(issued.recovery === undefined ? {} : { recovery: issued.recovery }),
                    ...(issued.grantPath === undefined ? {} : { grantPath: issued.grantPath }),
                },
            };
            await this.store.putPendingAuthorization(pending);
        }
        if (pending.ingressKey === undefined || pending.peerDataKey === undefined) {
            pending = {
                ...pending,
                ingressKey: pending.ingressKey ?? randomBytes(32).toString('base64'),
                peerDataKey: pending.peerDataKey ?? randomBytes(32).toString('base64'),
            };
            await this.store.putPendingAuthorization(pending);
        }
        const issued = pending.issued!;
        const grant = createDeviceGrant({
            machineId: this.options.machineId,
            machineSigningSecretKey: crypto.signingSecretKey,
            machineKey: { publicKey: crypto.boxPublicKey, secretKey: crypto.boxSecretKey },
            deviceId: issued.peerDeviceId,
            devicePublicKey: pending.peerPublicKey,
            dataKey: pending.peerDataKey!,
            ingressKey: pending.ingressKey!,
            keyVersion: crypto.keyVersion,
            expiresAt: PEER_CREDENTIAL_EXPIRES_AT,
            deviceKind: 'peer',
            capabilities: pending.capabilities,
            ...(pending.allowedCwds === undefined ? {} : { allowedCwds: pending.allowedCwds }),
        });
        await this.options.authority.uploadGrant(issued.peerDeviceId, JSON.stringify(grant), crypto.keyVersion, issued.recovery);
        if (pending.sealedBundle === undefined) {
            const payload: PeerInstallBundlePayload = {
                v: 1,
                relationshipId: pending.relationshipId,
                targetMachineId: this.options.machineId,
                targetMachineName: this.options.machineName,
                targetPlatform: this.options.platform,
                targetMachineSigningPublicKey: crypto.signingPublicKey,
                relayUrl: pending.relayUrl ?? this.options.relayUrl,
                peerDeviceId: issued.peerDeviceId,
                credential: issued.credential,
                ...(issued.grantPath === undefined ? {} : { grantPath: issued.grantPath }),
                grant,
                capabilities: [...pending.capabilities],
                issuedAt: this.now(),
                authority: issued.authority,
            };
            pending = {
                ...pending,
                sealedBundle: sealPeerInstallBundle({
                    payload,
                    targetMachineSigningSecretKey: crypto.signingSecretKey,
                    targetMachineKey: { publicKey: crypto.boxPublicKey, secretKey: crypto.boxSecretKey },
                    peerPublicKey: pending.peerPublicKey,
                }),
            };
            await this.store.putPendingAuthorization(pending);
        }
        const relationship: StoredPeerRelationship = {
            relationshipId: pending.relationshipId,
            direction: 'inbound',
            machineId: pending.sourceMachineId,
            ...(pending.sourceName === undefined ? {} : { machineName: pending.sourceName }),
            ...(pending.sourcePlatform === undefined ? {} : { platform: pending.sourcePlatform }),
            state: 'pending',
            capabilities: [...pending.capabilities],
            peerDeviceId: issued.peerDeviceId,
            createdAt: pending.createdAt,
            updatedAt: this.now(),
            keyVersion: crypto.keyVersion,
            authority: issued.authority,
            ...(pending.allowedCwds === undefined ? {} : { allowedCwds: pending.allowedCwds }),
            authorizationDescriptorHash: pending.descriptorHash,
            sealedInstallBundle: pending.sealedBundle!,
        };
        await this.store.putRelationship(relationship);
        const record: MachineDeviceRecord = {
            deviceId: issued.peerDeviceId,
            devicePublicKey: pending.peerPublicKey,
            ingressKey: pending.ingressKey!,
            dataKey: pending.peerDataKey!,
            expiresAt: new Date(PEER_CREDENTIAL_EXPIRES_AT).toISOString(),
            kind: 'peer',
            capabilities: [...pending.capabilities],
            ...(pending.allowedCwds === undefined ? {} : { allowedCwds: pending.allowedCwds }),
        };
        const latest = this.readyCrypto();
        const existing = latest.devices.find((device) => device.deviceId === issued.peerDeviceId);
        if (existing === undefined) await this.options.crypto.commit({ ...latest, devices: [...latest.devices, record] });
        else if (existing.devicePublicKey !== record.devicePublicKey || existing.ingressKey !== record.ingressKey || existing.dataKey !== record.dataKey) {
            throw operationError('pending peer crypto record changed', 'peer-operation-conflict');
        }
        const connected = { ...relationship, state: 'connected' as const, updatedAt: this.now() };
        await this.store.putRelationship(connected);
        await this.store.putPendingAuthorization(undefined);
        return this.authorizationResult(connected);
    }

    private authorizationResult(relationship: StoredPeerRelationship): PeerRequestResult<'peer.authorize'> {
        if (relationship.peerDeviceId === undefined || relationship.sealedInstallBundle === undefined || relationship.keyVersion === undefined) {
            throw operationError('peer authorization recovery record is incomplete', 'peer-operation-uncertain');
        }
        return {
            peerDeviceId: relationship.peerDeviceId,
            sealedBundle: relationship.sealedInstallBundle,
            capabilities: [...relationship.capabilities],
            keyVersion: relationship.keyVersion,
            ...(relationship.authority === undefined ? {} : { authority: relationship.authority }),
        };
    }

    private async install(params: Extract<PeerClientRequest, { type: 'peer.install' }>['params']): Promise<PeerRequestResult<'peer.install'>> {
        let opened: PeerInstallBundlePayload | undefined;
        let preparation = undefined as ReturnType<PeerStore['preparation']>;
        for (const candidate of this.store.preparationsForTarget(params.targetMachineId)) {
            try {
                const payload = openPeerInstallBundle(params.sealedBundle, {
                    peerKey: candidate.key,
                    pinnedTargetMachineSigningPublicKey: candidate.targetMachineSigningPublicKey,
                });
                if (payload.targetMachineId !== params.targetMachineId) continue;
                opened = payload;
                preparation = candidate;
                break;
            } catch {
                // A target may have multiple short-lived preparations; try only its own candidates.
            }
        }
        if (opened === undefined || preparation === undefined) throw operationError('peer install bundle failed verification', 'peer-bundle-invalid');
        const grant = verifyDeviceGrant(opened.grant, {
            pinnedMachineSigningPublicKey: preparation.targetMachineSigningPublicKey,
            deviceKey: preparation.key,
            deviceId: opened.peerDeviceId,
        });
        if (grant.deviceKind !== 'peer' || grant.machineId !== opened.targetMachineId
            || JSON.stringify(grant.capabilities) !== JSON.stringify(opened.capabilities)
            || params.relationshipId !== undefined && params.relationshipId !== opened.relationshipId) {
            throw operationError('peer install grant does not match its bundle', 'peer-bundle-invalid');
        }
        if (this.store.relationship(opened.relationshipId) !== undefined) {
            throw operationError('peer relationship id is already in use', 'peer-operation-conflict');
        }
        const now = this.now();
        const relationship: StoredPeerRelationship = {
            relationshipId: params.relationshipId ?? opened.relationshipId,
            direction: 'outbound',
            machineId: opened.targetMachineId,
            ...(opened.targetMachineName === undefined ? {} : { machineName: opened.targetMachineName }),
            ...(opened.targetPlatform === undefined ? {} : { platform: opened.targetPlatform }),
            state: 'connected',
            capabilities: [...opened.capabilities],
            peerDeviceId: opened.peerDeviceId,
            createdAt: now,
            updatedAt: now,
            keyVersion: grant.keyVersion,
            ...(opened.authority === undefined ? {} : { authority: opened.authority }),
            preparationId: preparation.preparationId,
            targetMachineSigningPublicKey: preparation.targetMachineSigningPublicKey,
            peerKey: preparation.key,
            relayUrl: opened.relayUrl,
            credential: opened.credential,
            sealedGrant: opened.grant,
            ...(opened.grantPath === undefined ? {} : { grantPath: opened.grantPath }),
            ...(grant.allowedCwds === undefined ? {} : { allowedCwds: grant.allowedCwds }),
            agentAliases: {},
        };
        await this.store.putRelationship(relationship);
        await this.store.removePreparation(preparation.preparationId);
        return publicRelationship(relationship);
    }

    private async revoke(params: Extract<PeerClientRequest, { type: 'peer.revoke' }>['params']): Promise<PeerRequestResult<'peer.revoke'>> {
        const authorization = this.store.pendingAuthorization();
        if (authorization?.relationshipId === params.relationshipId) {
            return this.cancelPendingAuthorization(authorization);
        }
        const relationship = this.store.relationship(params.relationshipId);
        if (relationship === undefined || relationship.state === 'revoked') {
            return { state: 'already-revoked', revokedAt: this.now() };
        }
        const recovery = this.options.crypto.get().pendingRotation;
        if (recovery?.kind === 'peer-revoke-v1' && recovery.revokedDeviceId === relationship.peerDeviceId) {
            await this.finishPeerRevocation(recovery);
            await this.store.putRelationship({ ...relationship, state: 'revoked', updatedAt: this.now() });
            return { state: 'revoked', revokedAt: this.now(), ...(relationship.authority === undefined ? {} : { authority: relationship.authority }) };
        }
        if (relationship.direction === 'outbound') {
            if (params.peerDeviceId !== relationship.peerDeviceId) {
                throw operationError('target revocation must be confirmed before deleting the outbound bundle', 'peer-revoke-unconfirmed');
            }
            this.outboundService.closeRelationship(relationship.relationshipId);
            const { credential: _credential, peerKey: _peerKey, sealedGrant: _sealedGrant, ...revoked } = relationship;
            await this.store.putRelationship({ ...revoked, state: 'revoked', updatedAt: this.now() });
            return { state: 'revoked', revokedAt: this.now(), ...(relationship.authority === undefined ? {} : { authority: relationship.authority }) };
        }
        if (relationship.peerDeviceId === undefined) throw operationError('peer relationship has no device binding', 'peer-revoke-invalid');
        const pending = this.buildPeerRevocation(relationship);
        await this.fencePeerRevocation(pending);
        await this.store.putRelationship({ ...relationship, state: 'disconnecting', updatedAt: this.now() });
        await this.finishPeerRevocation(pending);
        await this.store.putRelationship({ ...relationship, state: 'revoked', updatedAt: this.now() });
        return { state: 'revoked', revokedAt: this.now(), ...(relationship.authority === undefined ? {} : { authority: relationship.authority }) };
    }

    private async cancelPendingAuthorization(initial: StoredPendingAuthorization): Promise<PeerRequestResult<'peer.revoke'>> {
        let pending = this.store.pendingAuthorization() ?? initial;
        if (pending.issued === undefined) {
            const issued = await this.options.authority.issuePeer({
                peerPublicKey: pending.peerPublicKey,
                sourceMachineId: pending.sourceMachineId,
                sourceName: pending.sourceName || 'Peer computer',
                capabilities: [...pending.capabilities],
                credentialExpiresAt: PEER_CREDENTIAL_EXPIRES_AT,
                refreshAfter: PEER_CREDENTIAL_EXPIRES_AT,
            }, {
                ...(pending.authorityRecovery === undefined ? {} : { recovery: pending.authorityRecovery }),
                checkpoint: async (authorityRecovery) => {
                    pending = { ...pending, authorityRecovery };
                    await this.store.putPendingAuthorization(pending);
                },
            });
            pending = {
                ...pending,
                issued: {
                    peerDeviceId: issued.peerDeviceId,
                    credential: issued.credential,
                    authority: issued.authority,
                    ...(issued.recovery === undefined ? {} : { recovery: issued.recovery }),
                    ...(issued.grantPath === undefined ? {} : { grantPath: issued.grantPath }),
                },
            };
            await this.store.putPendingAuthorization(pending);
        }
        const issued = pending.issued!;
        const existing = this.store.relationship(pending.relationshipId);
        const relationship: StoredPeerRelationship = existing ?? {
            relationshipId: pending.relationshipId,
            direction: 'inbound',
            machineId: pending.sourceMachineId,
            ...(pending.sourceName === undefined ? {} : { machineName: pending.sourceName }),
            ...(pending.sourcePlatform === undefined ? {} : { platform: pending.sourcePlatform }),
            state: 'repair-needed',
            capabilities: [...pending.capabilities],
            peerDeviceId: issued.peerDeviceId,
            createdAt: pending.createdAt,
            updatedAt: this.now(),
            authority: issued.authority,
            authorizationDescriptorHash: pending.descriptorHash,
            ...(pending.sealedBundle === undefined ? {} : { sealedInstallBundle: pending.sealedBundle }),
        };
        await this.store.putRelationship(relationship);
        if (this.options.crypto.get().devices.some((device) => device.deviceId === issued.peerDeviceId)) {
            const rotation = this.buildPeerRevocation(relationship);
            await this.fencePeerRevocation(rotation);
            await this.store.putRelationship({ ...relationship, state: 'disconnecting', updatedAt: this.now() });
            await this.finishPeerRevocation(rotation);
        } else {
            await this.options.authority.revokePeer(issued.peerDeviceId);
            await this.store.putRelationship({ ...relationship, state: 'revoked', updatedAt: this.now() });
        }
        await this.store.putPendingAuthorization(undefined);
        return { state: 'revoked', revokedAt: this.now(), authority: issued.authority };
    }

    private async repairOrphanDevices(): Promise<void> {
        const relationships = this.store.list().peers;
        const bound = new Set(relationships
            .filter((relationship) => relationship.direction === 'inbound' && relationship.state !== 'revoked'
                && relationship.machineId !== 'unfinished-peer-authorization')
            .map((relationship) => relationship.peerDeviceId));
        const pendingDeviceId = this.store.pendingAuthorization()?.issued?.peerDeviceId;
        if (pendingDeviceId !== undefined) bound.add(pendingDeviceId);
        for (const device of this.readyCrypto().devices.filter((candidate) => candidate.kind === 'peer' && !bound.has(candidate.deviceId))) {
            const relationship: StoredPeerRelationship = {
                relationshipId: `repair_${createHash('sha256').update(device.deviceId).digest('base64url').slice(0, 24)}`,
                direction: 'inbound',
                machineId: 'unfinished-peer-authorization',
                machineName: 'Peer computer',
                state: 'repair-needed',
                capabilities: [...(device.capabilities ?? DEFAULT_PEER_CAPABILITIES)],
                peerDeviceId: device.deviceId,
                createdAt: this.now(),
                updatedAt: this.now(),
                ...(device.allowedCwds === undefined ? {} : { allowedCwds: [...device.allowedCwds] }),
            };
            await this.store.putRelationship(relationship);
            const rotation = this.buildPeerRevocation(relationship);
            await this.fencePeerRevocation(rotation);
            await this.store.putRelationship({ ...relationship, state: 'disconnecting', updatedAt: this.now() });
            await this.finishPeerRevocation(rotation);
        }
    }

    private async finishPeerRevocation(pending: MachinePendingRotation): Promise<void> {
        if (pending.kind !== 'peer-revoke-v1' || pending.revokedDeviceId === undefined
            || pending.previousKeyVersion === undefined || pending.authorityKind !== this.options.authority.kind) {
            throw new Error('peer revocation recovery state is invalid');
        }
        await this.fencePeerRevocation(pending);
        await this.options.authority.revokePeer(pending.revokedDeviceId);
        await this.options.authority.publishRotation(pending.keyVersion, pending.grants);
        const { pendingRotation: _pendingRotation, ...completed } = this.options.crypto.get();
        await this.options.crypto.commit(completed);
        const relationship = this.store.list().peers.find((entry) => entry.peerDeviceId === pending.revokedDeviceId && entry.direction === 'inbound');
        if (relationship !== undefined) {
            const stored = this.store.relationship(relationship.relationshipId)!;
            await this.store.putRelationship({ ...stored, state: 'revoked', updatedAt: this.now() });
        }
    }

    private async fencePeerRevocation(pending: MachinePendingRotation): Promise<void> {
        let current = this.options.crypto.get();
        if (current.keyVersion === pending.previousKeyVersion) {
            current = {
                ...current,
                dataKey: pending.dataKey,
                keyVersion: pending.keyVersion,
                devices: pending.devices,
                pendingRotation: pending,
            };
            await this.options.crypto.commit(current);
            return;
        }
        if (current.keyVersion !== pending.keyVersion) {
            throw new Error('peer revocation key version changed; refusing to overwrite it');
        }
        if (current.dataKey !== pending.dataKey || JSON.stringify(current.devices) !== JSON.stringify(pending.devices)) {
            throw new Error('peer revocation recovery candidate changed; refusing to publish mismatched grants');
        }
        if (current.pendingRotation === undefined) await this.options.crypto.commit({ ...current, pendingRotation: pending });
    }

    private buildPeerRevocation(relationship: StoredPeerRelationship): MachinePendingRotation {
        const crypto = this.readyCrypto();
        const revokedDeviceId = relationship.peerDeviceId;
        if (revokedDeviceId === undefined) throw operationError('peer relationship has no device binding', 'peer-revoke-invalid');
        const devices = crypto.devices.filter((device) => device.deviceId !== revokedDeviceId).map((device) => ({
            deviceId: device.deviceId,
            devicePublicKey: device.devicePublicKey,
            ingressKey: randomBytes(32).toString('base64'),
            expiresAt: device.expiresAt,
            ...(device.kind === undefined ? {} : { kind: device.kind }),
            ...(device.authority === undefined ? {} : { authority: device.authority }),
            ...(device.kind === 'peer' ? { dataKey: randomBytes(32).toString('base64') } : {}),
            ...(device.capabilities === undefined ? {} : { capabilities: [...device.capabilities] }),
            ...(device.allowedCwds === undefined ? {} : { allowedCwds: [...device.allowedCwds] }),
        }));
        if (devices.length === crypto.devices.length) throw operationError('peer device is no longer present', 'peer-revoke-invalid');
        const dataKey = randomBytes(32).toString('base64');
        const keyVersion = crypto.keyVersion + 1;
        const grants = devices.map((device) => ({
            deviceId: device.deviceId,
            devicePublicKey: device.devicePublicKey,
            grant: JSON.stringify(createDeviceGrant({
                machineId: this.options.machineId,
                machineSigningSecretKey: crypto.signingSecretKey,
                machineKey: { publicKey: crypto.boxPublicKey, secretKey: crypto.boxSecretKey },
                deviceId: device.deviceId,
                devicePublicKey: device.devicePublicKey,
                dataKey: device.kind === 'peer' ? device.dataKey! : dataKey,
                ingressKey: device.ingressKey,
                keyVersion,
                expiresAt: Date.parse(device.expiresAt),
                ...(device.kind === 'peer' ? {
                    deviceKind: 'peer' as const,
                    capabilities: device.capabilities ?? DEFAULT_PEER_CAPABILITIES,
                    ...(device.allowedCwds === undefined ? {} : { allowedCwds: device.allowedCwds }),
                } : {
                    ...(device.kind === 'browser' ? { deviceKind: 'browser' as const } : {}),
                    authority: device.authority ?? (device.kind === 'browser' ? 'observe' as const : 'control' as const),
                }),
            })),
        }));
        return {
            kind: 'peer-revoke-v1',
            authorityKind: this.options.authority.kind,
            revokedDeviceId,
            revokedDeviceName: relationship.machineName ?? 'Peer computer',
            previousKeyVersion: crypto.keyVersion,
            keyVersion,
            dataKey,
            devices,
            grants,
        };
    }

    private readyCrypto(): MachineCryptoState {
        const crypto = this.options.crypto.get();
        if (crypto.pendingRotation !== undefined) throw operationError('machine key rotation is incomplete', 'peer-rotation-pending');
        return crypto;
    }

    private validateStartDirectories(capabilities: readonly PeerCapability[], value: string[] | undefined): string[] | undefined {
        if (!capabilities.includes('start')) {
            if (value !== undefined) throw operationError('allowed directories require the start capability', 'peer-invalid-capabilities');
            return undefined;
        }
        if (!Array.isArray(value) || value.length === 0 || value.length > 16
            || value.some((cwd) => typeof cwd !== 'string' || cwd.trim() === '' || !isAbsolute(cwd))) {
            throw operationError('peer start requires absolute approved directories', 'peer-invalid-capabilities');
        }
        try { return [...new Set(value.map((cwd) => realpathSync(cwd)))]; }
        catch { throw operationError('approved peer start directories must already exist', 'peer-invalid-capabilities'); }
    }

    private startAllowed(cwd: string, allowed: readonly string[] | undefined): boolean {
        if (allowed === undefined) return false;
        let target: string;
        try { target = realpathSync(cwd); } catch { return false; }
        return allowed.some((root) => {
            try {
                const child = relative(realpathSync(root), target);
                return child === '' || child !== '..' && !child.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) && !isAbsolute(child);
            } catch { return false; }
        });
    }

    async acknowledgeSemantic(request: Extract<PeerClientRequest, { type: 'peer.remote.watch' | 'peer.remote.prompt' | 'peer.remote.start' }>): Promise<void> {
        await this.outboundService.acknowledgeSemantic(request);
    }

    async outboundRelationships(): Promise<StoredPeerRelationship[]> {
        return this.outboundService.relationships();
    }

    async resolveOutboundMachine(alias: string): Promise<StoredPeerRelationship> {
        return this.outboundService.resolveMachine(alias);
    }

    private assertRecoveryReady(): void {
        if (this.recoveryPending) throw operationError('peer recovery is pending; retry after connectivity returns', 'peer-recovery-pending');
    }

    private hasRecoveryWork(): boolean {
        if (this.options.crypto.get().pendingRotation?.kind === 'peer-revoke-v1' || this.store.pendingAuthorization() !== undefined) return true;
        const bound = new Set(this.store.list().peers
            .filter((entry) => entry.direction === 'inbound' && entry.state !== 'revoked')
            .map((entry) => entry.peerDeviceId));
        return this.options.crypto.get().devices.some((device) => device.kind === 'peer' && !bound.has(device.deviceId));
    }

    private noteRecoveryWork(): void {
        if (!this.hasRecoveryWork()) return;
        this.recoveryPending = true;
        this.scheduleRecovery();
    }

    private scheduleRecovery(): void {
        if (this.recoveryTimer !== undefined) return;
        const delay = Math.min(1_000 * 2 ** this.recoveryAttempts++, 30_000);
        this.recoveryTimer = setTimeout(() => {
            this.recoveryTimer = undefined;
            void this.recover().catch(() => undefined);
        }, delay);
        this.recoveryTimer.unref?.();
    }

    private withCryptoLock<T>(operation: () => Promise<T>): Promise<T> {
        const run = this.cryptoQueue.then(operation);
        this.cryptoQueue = run.then(() => undefined, () => undefined);
        return run;
    }
}
