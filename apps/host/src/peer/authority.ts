import { createHash, randomBytes } from 'node:crypto';
import type { PeerAuthorityMetadata, PeerCapability } from '@muxr/contract';
import type { MachineRotationGrant } from './types.js';

export interface PeerAuthorityIssueRecovery {
    pairId: string;
    controlClaim: string;
}

interface IssuedPeer {
    peerDeviceId: string;
    credential: string;
    authority: PeerAuthorityMetadata;
    recovery?: PeerAuthorityIssueRecovery;
    grantPath?: string;
}

export interface PeerAuthority {
    readonly kind: 'selfhost' | 'hosted';
    issuePeer(input: {
        peerPublicKey: string;
        sourceMachineId: string;
        sourceName: string;
        capabilities: PeerCapability[];
        credentialExpiresAt: number;
        refreshAfter: number;
    }, options?: {
        recovery?: PeerAuthorityIssueRecovery;
        checkpoint?: (recovery: PeerAuthorityIssueRecovery) => Promise<void>;
    }): Promise<IssuedPeer>;
    uploadGrant(peerDeviceId: string, grant: string, keyVersion: number, recovery?: PeerAuthorityIssueRecovery): Promise<void>;
    revokePeer(peerDeviceId: string): Promise<void>;
    publishRotation(keyVersion: number, grants: MachineRotationGrant[]): Promise<void>;
}

interface HttpPeerAuthorityOptions {
    kind: 'selfhost' | 'hosted';
    controlUrl: string;
    machineId: string;
    credential: string;
    fetch?: typeof fetch;
}

export class HttpPeerAuthority implements PeerAuthority {
    readonly kind: 'selfhost' | 'hosted';
    private readonly fetchImpl: typeof fetch;
    private readonly base: string;

    constructor(private readonly options: HttpPeerAuthorityOptions) {
        this.kind = options.kind;
        this.fetchImpl = options.fetch ?? fetch;
        this.base = options.controlUrl.replace(/\/+$/, '');
    }

    async issuePeer(
        input: Parameters<PeerAuthority['issuePeer']>[0],
        options?: Parameters<PeerAuthority['issuePeer']>[1],
    ): Promise<IssuedPeer> {
        return this.kind === 'selfhost' ? this.issueSelfhost(input) : this.issueHosted(input, options);
    }

    private async issueSelfhost(input: Parameters<PeerAuthority['issuePeer']>[0]): Promise<IssuedPeer> {
        const peersPath = `/v1/selfhost/peers?machine=${encodeURIComponent(this.options.machineId)}`;
        const listed = await this.json(peersPath, { method: 'GET' }) as { peers?: unknown };
        const existing = Array.isArray(listed.peers)
            ? listed.peers.find((value) => {
                const peer = value as Record<string, unknown>;
                return peer.publicKey === input.peerPublicKey && peer.revokedAt === undefined;
            }) as Record<string, unknown> | undefined
            : undefined;
        if (existing !== undefined && typeof existing.deviceId === 'string') {
            const rotated = await this.json(`/v1/selfhost/peers/${encodeURIComponent(existing.deviceId)}/rotate?machine=${encodeURIComponent(this.options.machineId)}`, {
                method: 'POST',
                body: JSON.stringify({
                    credential_expires_at: input.credentialExpiresAt,
                    refresh_after: input.refreshAfter,
                    authority_id: `selfhost:${this.options.machineId}`,
                }),
            }) as Record<string, unknown>;
            if (typeof rotated.device_credential !== 'string') throw new Error('selfhost peer authority returned an invalid recovery response');
            return this.issued(existing.deviceId, rotated.device_credential, input);
        }
        const result = await this.json(peersPath, {
            method: 'POST',
            body: JSON.stringify({
                device_public_key: input.peerPublicKey,
                device_name: input.sourceName,
                peer_machine_id: input.sourceMachineId,
                capabilities: input.capabilities,
                credential_expires_at: input.credentialExpiresAt,
                refresh_after: input.refreshAfter,
                authority_id: `selfhost:${this.options.machineId}`,
            }),
        }) as Record<string, unknown>;
        if (typeof result.device_id !== 'string' || typeof result.device_credential !== 'string') {
            throw new Error('selfhost peer authority returned an invalid issue response');
        }
        return this.issued(result.device_id, result.device_credential, input);
    }

    private async issueHosted(
        input: Parameters<PeerAuthority['issuePeer']>[0],
        options?: Parameters<PeerAuthority['issuePeer']>[1],
    ): Promise<IssuedPeer> {
        let recovery = options?.recovery;
        if (recovery !== undefined) {
            const status = await this.json(`/v1/pair-sessions/${encodeURIComponent(recovery.pairId)}`, { method: 'GET' }, true) as Record<string, unknown>;
            if (status.state === 'claimed') {
                const device = status.device as Record<string, unknown> | undefined;
                if (device?.public_key !== input.peerPublicKey || typeof device.id !== 'string') {
                    throw new Error('hosted peer recovery found a different claimed device');
                }
                await this.json(`/v1/devices/${encodeURIComponent(device.id)}/revoke`, { method: 'POST' }, true);
                recovery = undefined;
            } else if (status.state !== 'pending') {
                recovery = undefined;
            }
        }
        if (recovery === undefined) {
            const controlClaim = randomBytes(32).toString('base64url');
            const created = await this.json('/v1/pair-sessions', {
                method: 'POST',
                body: JSON.stringify({
                    control_claim_hash: createHash('sha256').update(controlClaim).digest('base64url'),
                }),
            }) as Record<string, unknown>;
            if (typeof created.pair_id !== 'string') throw new Error('hosted peer authority returned an invalid pair-session response');
            recovery = { pairId: created.pair_id, controlClaim };
            await options?.checkpoint?.(recovery);
        }
        const claimed = await this.json(`/v1/pair-sessions/${encodeURIComponent(recovery.pairId)}/claim`, {
            method: 'POST',
            body: JSON.stringify({
                control_claim: recovery.controlClaim,
                device_public_key: input.peerPublicKey,
                device_name: input.sourceName,
                device_kind: 'peer',
                mailbox: JSON.stringify({ v: 1, purpose: 'peer-authorization', source_machine_id: input.sourceMachineId }),
            }),
        }, false, false) as Record<string, unknown>;
        const device = claimed.device as Record<string, unknown> | undefined;
        if (typeof claimed.access_token !== 'string' || typeof device?.id !== 'string') {
            throw new Error('hosted peer authority returned an invalid claim response');
        }
        return {
            ...this.issued(device.id, claimed.access_token, input),
            recovery,
            grantPath: `/v1/pair-sessions/${encodeURIComponent(recovery.pairId)}/grant`,
        };
    }

    private issued(peerDeviceId: string, credential: string, input: Parameters<PeerAuthority['issuePeer']>[0]): IssuedPeer {
        return {
            peerDeviceId,
            credential,
            authority: {
                authorityId: `${this.kind}:${this.options.machineId}`,
                credentialExpiresAt: input.credentialExpiresAt,
                refreshAfter: input.refreshAfter,
            },
        };
    }

    async uploadGrant(peerDeviceId: string, grant: string, keyVersion: number, recovery?: PeerAuthorityIssueRecovery): Promise<void> {
        if (this.kind === 'hosted') {
            if (recovery === undefined) throw new Error('hosted peer grant upload is missing its pair-session recovery binding');
            await this.json(`/v1/pair-sessions/${encodeURIComponent(recovery.pairId)}/grant`, {
                method: 'POST', body: JSON.stringify({ grant }),
            });
            return;
        }
        await this.json(`/v1/selfhost/peers/${encodeURIComponent(peerDeviceId)}/grant?machine=${encodeURIComponent(this.options.machineId)}`, {
            method: 'POST', body: JSON.stringify({ grant, key_version: keyVersion }),
        });
    }

    async revokePeer(peerDeviceId: string): Promise<void> {
        if (this.kind === 'hosted') {
            await this.json(`/v1/devices/${encodeURIComponent(peerDeviceId)}/revoke`, { method: 'POST' }, true);
            return;
        }
        await this.json(`/v1/selfhost/peers/${encodeURIComponent(peerDeviceId)}?machine=${encodeURIComponent(this.options.machineId)}`, { method: 'DELETE' }, true);
    }

    async publishRotation(keyVersion: number, grants: MachineRotationGrant[]): Promise<void> {
        const machine = encodeURIComponent(this.options.machineId);
        const path = this.kind === 'selfhost'
            ? `/v1/selfhost/machines/${machine}/grants`
            : `/v1/machines/${machine}/keys/rotate`;
        const body = this.kind === 'selfhost'
            ? { key_version: keyVersion, grants: grants.map((entry) => ({ device_id: entry.deviceId, grant: entry.grant })) }
            : { grants: grants.map((entry) => ({ device_public_key: entry.devicePublicKey, grant: entry.grant })) };
        await this.json(path, { method: 'POST', body: JSON.stringify(body) });
    }

    private async json(path: string, init: RequestInit, allowMissing = false, authenticated = true): Promise<unknown> {
        const response = await this.fetchImpl(`${this.base}${path}`, {
            ...init,
            headers: {
                ...(authenticated ? { authorization: `Bearer ${this.options.credential}` } : {}),
                'content-type': 'application/json',
            },
            signal: AbortSignal.timeout(15_000),
        });
        let body: Record<string, unknown> = {};
        try { body = await response.json() as Record<string, unknown>; } catch { /* status is enough */ }
        if (!response.ok && !(allowMissing && response.status === 404)) {
            throw new Error(typeof body.error === 'string' ? body.error : `${this.kind} peer authority failed (${response.status})`);
        }
        return body;
    }
}
