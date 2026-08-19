/**
 * Session-scoped version diagnostic for Settings -> Connection. Nothing is
 * persisted: the host announces its build version on `machine.hello` /
 * `machines.list`, the app knows its own from expo-constants, and the row is
 * recomputed on every render.
 *
 * Hosts predating the wire-up announce '0.0.0' (the field shipped but was
 * never fed a real version), and the machine mapper used 'muxr' as the
 * placeholder for a host that says nothing — both mean "unknown", and an
 * unknown host version must not raise a mismatch.
 */
export function knownHostVersion(hostVersion: string | undefined): string | undefined {
    if (hostVersion === undefined || hostVersion === '0.0.0' || hostVersion === 'muxr') return undefined;
    return hostVersion;
}

export function versionsMismatch(appVersion: string, hostVersion: string | undefined): boolean {
    const known = knownHostVersion(hostVersion);
    return known !== undefined && known !== appVersion;
}
