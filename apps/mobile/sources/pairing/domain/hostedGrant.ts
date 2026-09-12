export type DeviceAuthority = 'control' | 'observe';

export function grantAuthorizesMachine(
    grant: { machineId: string } | undefined,
    machineId: string,
): boolean {
    const normalized = machineId.trim();
    return normalized !== '' && grant?.machineId === normalized;
}

export function hostedTransportReady(
    mode: 'hosted' | 'local',
    machineId: string,
    grant: { machineId: string } | undefined,
): boolean {
    return mode === 'local' || grantAuthorizesMachine(grant, machineId);
}

/** Web pairing is observe unless the grant itself recorded control. */
export function defaultDeviceAuthority(platform: string): DeviceAuthority {
    return platform === 'web' ? 'observe' : 'control';
}

export type VerifiedGrantDecision =
    | { ok: true; authority: DeviceAuthority }
    | { ok: false; error: 'machine-substitution' | 'authority-substitution' | 'lifetime-substitution' };

/** Reviewed browser lifetimes; the host mints the real expiry and this caps it. */
export const BROWSER_GRANT_TTL_MS = 8 * 60 * 60_000;
export const BROWSER_PERSONAL_GRANT_TTL_MS = 30 * 24 * 60 * 60_000;
/** Slack for a grant minted a little before the claim completed. */
const GRANT_LIFETIME_SLACK_MS = 10 * 60_000;

export function reviewedGrantCeiling(lifetime: 'eight hours' | '30 days', claimedAt: number): number {
    return claimedAt + (lifetime === '30 days' ? BROWSER_PERSONAL_GRANT_TTL_MS : BROWSER_GRANT_TTL_MS) + GRANT_LIFETIME_SLACK_MS;
}

/**
 * Stable machine id authorizes; display name never does. Authority and
 * lifetime may only be what the person reviewed at consent.
 */
export function acceptVerifiedGrant(args: {
    verifiedMachineId: string;
    pendingMachineId: string;
    verifiedAuthority: DeviceAuthority | undefined;
    expectedAuthority: DeviceAuthority | undefined;
    verifiedExpiresAt?: number;
    /** Latest acceptable expiry for a browser grant; absent for native (until revoked). */
    expiresNoLaterThan?: number;
    platform: string;
}): VerifiedGrantDecision {
    if (args.verifiedMachineId !== args.pendingMachineId) return { ok: false, error: 'machine-substitution' };
    const authority = args.verifiedAuthority ?? defaultDeviceAuthority(args.platform);
    if (args.expectedAuthority !== undefined && authority !== args.expectedAuthority) {
        return { ok: false, error: 'authority-substitution' };
    }
    if (args.expiresNoLaterThan !== undefined
        && (args.verifiedExpiresAt === undefined || !Number.isFinite(args.verifiedExpiresAt) || args.verifiedExpiresAt > args.expiresNoLaterThan)) {
        return { ok: false, error: 'lifetime-substitution' };
    }
    return { ok: true, authority };
}

export function grantRejectsDowngrade(existingVersion: number, nextVersion: number): boolean {
    return nextVersion < existingVersion;
}

export function pickGrantForConnection<T extends { machineId: string }>(
    settings: { mode: 'hosted' | 'local'; machineId: string },
    paired: readonly T[],
): T | undefined {
    if (settings.mode !== 'hosted') return undefined;
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

/** Self-host relays have no account surface; the Hosted Grant is the session. */
export function accountSurfaceApplies(
    mode: 'hosted' | 'local',
    selfhost: boolean | undefined,
    grantSource: 'selfhost' | undefined,
): boolean {
    if (mode !== 'hosted') return false;
    return selfhost !== true && grantSource !== 'selfhost';
}
