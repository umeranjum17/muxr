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
