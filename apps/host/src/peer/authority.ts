import type { PeerAuthorityMetadata, PeerCapability } from '@muxr/contract';
import type { MachineRotationGrant } from './types.js';

export interface PeerAuthority {
    readonly kind: 'selfhost' | 'hosted';
    issuePeer(input: {
        peerPublicKey: string;
        sourceMachineId: string;
        sourceName: string;
        capabilities: PeerCapability[];
        credentialExpiresAt: number;
        refreshAfter: number;
    }): Promise<{ peerDeviceId: string; credential: string; authority: PeerAuthorityMetadata }>;
    uploadGrant(peerDeviceId: string, grant: string, keyVersion: number): Promise<void>;
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

/** Hosted route names stay isolated here until that control plane lands parity. */
function routes(kind: 'selfhost' | 'hosted', machineId: string) {
    const machine = encodeURIComponent(machineId);
    return kind === 'selfhost' ? {
        peers: '/v1/selfhost/peers',
        peer: (deviceId: string) => `/v1/selfhost/peers/${encodeURIComponent(deviceId)}`,
        rotation: `/v1/selfhost/machines/${machine}/grants`,
    } : {
        peers: `/v1/machines/${machine}/peers`,
        peer: (deviceId: string) => `/v1/machines/${machine}/peers/${encodeURIComponent(deviceId)}`,
        rotation: `/v1/machines/${machine}/keys/rotate`,
    };
}

export class HttpPeerAuthority implements PeerAuthority {
    readonly kind: 'selfhost' | 'hosted';
    private readonly fetchImpl: typeof fetch;
    private readonly base: string;
    private readonly paths: ReturnType<typeof routes>;

    constructor(private readonly options: HttpPeerAuthorityOptions) {
        this.kind = options.kind;
        this.fetchImpl = options.fetch ?? fetch;
        this.base = options.controlUrl.replace(/\/+$/, '');
        this.paths = routes(options.kind, options.machineId);
    }

    async issuePeer(input: Parameters<PeerAuthority['issuePeer']>[0]): Promise<Awaited<ReturnType<PeerAuthority['issuePeer']>>> {
        const result = await this.json(this.paths.peers, {
            method: 'POST',
            body: JSON.stringify({
                device_public_key: input.peerPublicKey,
                device_name: input.sourceName,
                peer_machine_id: input.sourceMachineId,
                capabilities: input.capabilities,
                credential_expires_at: input.credentialExpiresAt,
                refresh_after: input.refreshAfter,
                authority_id: `${this.kind}:${this.options.machineId}`,
            }),
        }) as Record<string, unknown>;
        if (typeof result.device_id !== 'string' || typeof result.device_credential !== 'string') {
            throw new Error(`${this.kind} peer authority returned an invalid issue response`);
        }
        return {
            peerDeviceId: result.device_id,
            credential: result.device_credential,
            authority: {
                authorityId: `${this.kind}:${this.options.machineId}`,
                credentialExpiresAt: input.credentialExpiresAt,
                refreshAfter: input.refreshAfter,
            },
        };
    }

    async uploadGrant(peerDeviceId: string, grant: string, keyVersion: number): Promise<void> {
        await this.json(`${this.paths.peer(peerDeviceId)}/grant`, {
            method: 'POST', body: JSON.stringify({ grant, key_version: keyVersion }),
        });
    }

    async revokePeer(peerDeviceId: string): Promise<void> {
        await this.json(this.paths.peer(peerDeviceId), { method: 'DELETE' }, true);
    }

    async publishRotation(keyVersion: number, grants: MachineRotationGrant[]): Promise<void> {
        const body = this.kind === 'selfhost'
            ? { key_version: keyVersion, grants: grants.map((entry) => ({ device_id: entry.deviceId, grant: entry.grant })) }
            : { grants: grants.map((entry) => ({ device_public_key: entry.devicePublicKey, grant: entry.grant })) };
        await this.json(this.paths.rotation, { method: 'POST', body: JSON.stringify(body) });
    }

    private async json(path: string, init: RequestInit, allowMissing = false): Promise<unknown> {
        const response = await this.fetchImpl(`${this.base}${path}`, {
            ...init,
            headers: { authorization: `Bearer ${this.options.credential}`, 'content-type': 'application/json' },
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
