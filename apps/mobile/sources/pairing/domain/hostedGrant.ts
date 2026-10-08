import { hostId, parseOffer, unb64url, type PairOffer } from '@byokit/link';
import { linkUrl } from '@byokit/relay/device';
import { decodeBase64 } from '@/encryption/base64';

export type DeviceAuthority = 'control' | 'observe';

export function grantAuthorizesMachine(
    grant: { machineId: string } | undefined,
    machineId: string,
): boolean {
    const normalized = machineId.trim();
    return normalized !== '' && grant?.machineId === normalized;
}

export function hostedTransportReady(
    machineId: string,
    grant: { machineId: string } | undefined,
): boolean {
    return grantAuthorizesMachine(grant, machineId);
}

/** Web pairing is observe unless the grant itself recorded control. */
export function defaultDeviceAuthority(platform: string): DeviceAuthority {
    return platform === 'web' ? 'observe' : 'control';
}

export type VerifiedGrantDecision =
    | { ok: true; authority: DeviceAuthority }
    | { ok: false; error: 'machine-substitution' | 'authority-substitution' };

/** Stable machine id authorizes; display name never does. */
export function acceptVerifiedGrant(args: {
    verifiedMachineId: string;
    pendingMachineId: string;
    verifiedAuthority: DeviceAuthority | undefined;
    expectedAuthority: DeviceAuthority | undefined;
    platform: string;
}): VerifiedGrantDecision {
    if (args.verifiedMachineId !== args.pendingMachineId) return { ok: false, error: 'machine-substitution' };
    const authority = args.verifiedAuthority ?? defaultDeviceAuthority(args.platform);
    if (args.expectedAuthority !== undefined && authority !== args.expectedAuthority) {
        return { ok: false, error: 'authority-substitution' };
    }
    return { ok: true, authority };
}

export function grantRejectsDowngrade(existingVersion: number, nextVersion: number): boolean {
    return nextVersion < existingVersion;
}

export function pickGrantForConnection<T extends { machineId: string }>(
    settings: { machineId: string },
    paired: readonly T[],
): T | undefined {
    const remembered = paired.find((entry) => entry.machineId === settings.machineId);
    if (remembered !== undefined) return remembered;
    if (settings.machineId === '' && paired.length === 1) return paired[0];
    return undefined;
}

export function connectionShouldAdoptGrant(
    settings: { machineId: string; relayUrl: string; selfhost?: boolean },
    grant: { machineId: string; relayUrl: string; source?: 'selfhost' },
): boolean {
    return settings.machineId !== grant.machineId
        || settings.relayUrl !== grant.relayUrl
        || settings.selfhost !== (grant.source === 'selfhost' ? true : undefined);
}

/**
 * Match the pinned box key by host id and require an exact offer URL match
 * with the grant's proven link URL, or its canonical machine link when absent
 * (the same conversion as infrastructure/linkGrant.ts). Sharing a relay alone
 * is not enough. Expiry is ignored so a consumed offer remains recognizable;
 * unparseable offers never match. pairArrival.ts owns when this skips consent.
 */
export function offerMatchesGrant(
    offer: string,
    grant: { machineBoxPublicKey: string; relayUrl: string; linkUrl?: string },
): boolean {
    let parsed: PairOffer;
    try {
        // now=0 inspects without rejecting expiry.
        parsed = parseOffer(offer, 0);
    } catch {
        return false;
    }
    let offerKey: Uint8Array;
    let grantKey: Uint8Array;
    try {
        offerKey = unb64url(parsed.host);
        grantKey = decodeBase64(grant.machineBoxPublicKey, 'base64');
    } catch {
        return false;
    }
    if (hostId(offerKey) !== hostId(grantKey)) return false;
    return parsed.urls.includes(grant.linkUrl ?? linkUrl(grant.relayUrl, hostId(grantKey)));
}
