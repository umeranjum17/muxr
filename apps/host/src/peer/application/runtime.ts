import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import {
    DEFAULT_PEER_CAPABILITIES,
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
    type PeerInstallBundlePayload,
} from '@muxr/crypto';
import type { PeerAuthority } from '../infrastructure/authority.js';
import type { PeerClientTransport, PeerConnectionDiagnostic } from '../infrastructure/client.js';
import { OutboundPeerService } from './outboundPeerService.js';
import { PeerReceiptExecutor } from './receiptExecutor.js';
import { PeerStore, type StoredPendingAuthorization, type StoredPeerRelationship } from '../infrastructure/store.js';
import type { MachineCryptoAdapter, MachineCryptoState, MachineDeviceRecord, MachinePendingRotation } from '../../machine/index.js';
import { DeviceGrant } from '../../machine/index.js';
import { type PeerDeviceContext } from '../domain/startPolicy.js';
import { admitPeerRequest } from './admitPeerRequest.js';
import { grantPeerAuthority } from './grantPeerAuthority.js';
import { revokePeerAuthority } from './revokePeerAuthority.js';

const PEER_CREDENTIAL_EXPIRES_AT = Date.UTC(9999, 11, 31, 23, 59, 59, 999);

export type { PeerDeviceContext };

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

function canonicalRelayUrl(value: string): string {
    relayControlUrl(value);
    const relay = new URL(value);
    relay.search = '';
    relay.hash = '';
    return relay.toString().replace(/\/+$/, '');
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
            if (request.type === 'peer.authorize') return await this.withCryptoLock(() => grantPeerAuthority(this.grantFleet(), request.params));
            // Revocation is authenticated, destructive only to access, and idempotent. It must never
            // compete with attacker-controlled mutation receipts for admission.
            if (request.type === 'peer.revoke') return await this.withCryptoLock(() => revokePeerAuthority(this.revokeFleet(), request.params));
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
        return admitPeerRequest({
            startAllowed: (cwd, allowed) => this.startAllowed(cwd, allowed),
            assertRecoveryReady: () => this.assertRecoveryReady(),
            noteRecoveryWork: () => this.noteRecoveryWork(),
            executeReceipt: (id, type, mutation, params, run) => this.receipts.execute(id, type, mutation, params, run),
        }, request, deviceId, context, execute);
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

    private grantFleet() {
        return {
            now: this.now,
            machineId: this.options.machineId,
            relayUrl: this.options.relayUrl,
            readyCrypto: () => this.readyCrypto(),
            store: this.store,
            validateStartDirectories: (capabilities: readonly PeerCapability[], value: string[] | undefined) => this.validateStartDirectories(capabilities, value),
            repairOrphanDevices: () => this.repairOrphanDevices(),
            canonicalRelayUrl,
            fail: operationError,
            finishAuthorization: (pending: StoredPendingAuthorization) => this.finishAuthorization(pending),
            authorizationResult: (relationship: StoredPeerRelationship) => this.authorizationResult(relationship),
        };
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

    private revokeFleet() {
        return {
            now: this.now,
            store: this.store,
            pendingRotation: () => this.options.crypto.get().pendingRotation,
            cancelPendingAuthorization: (pending: StoredPendingAuthorization) => this.cancelPendingAuthorization(pending),
            finishPeerRevocation: (pending: MachinePendingRotation) => this.finishPeerRevocation(pending),
            closeOutbound: (relationshipId: string) => this.outboundService.closeRelationship(relationshipId),
            buildPeerRevocation: (relationship: StoredPeerRelationship) => this.buildPeerRevocation(relationship),
            fencePeerRevocation: (pending: MachinePendingRotation) => this.fencePeerRevocation(pending),
            fail: operationError,
        };
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
        this.refreshRecoveryState();
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
        for (const device of this.readyCrypto().devices.filter((candidate) => DeviceGrant.from(candidate).isPeer() && !bound.has(candidate.deviceId))) {
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
            ...(DeviceGrant.from(device).isPeer() ? { dataKey: randomBytes(32).toString('base64') } : {}),
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
                dataKey: DeviceGrant.from(device).isPeer() ? device.dataKey! : dataKey,
                ingressKey: device.ingressKey,
                keyVersion,
                expiresAt: Date.parse(device.expiresAt),
                ...DeviceGrant.from(device).sealedAudience(DEFAULT_PEER_CAPABILITIES),
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
        return allowed.some((root) => this.pathIsInsideApprovedRoot(root, target));
    }

    private pathIsInsideApprovedRoot(root: string, target: string): boolean {
        try {
            const child = relative(realpathSync(root), target);
            if (child === '') return true;
            if (isAbsolute(child)) return false;
            if (child === '..') return false;
            const parentPrefix = `..${process.platform === 'win32' ? '\\' : '/'}`;
            if (child.startsWith(parentPrefix)) return false;
            return true;
        } catch {
            return false;
        }
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
        return this.options.crypto.get().devices.some((device) => DeviceGrant.from(device).isPeer() && !bound.has(device.deviceId));
    }

    private noteRecoveryWork(): void {
        if (!this.hasRecoveryWork()) return;
        this.recoveryPending = true;
        this.scheduleRecovery();
    }

    private refreshRecoveryState(): void {
        this.recoveryPending = this.hasRecoveryWork();
        if (this.recoveryPending || this.recoveryTimer === undefined) return;
        clearTimeout(this.recoveryTimer);
        this.recoveryTimer = undefined;
        this.recoveryAttempts = 0;
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
