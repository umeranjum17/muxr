/**
 * Session-scoped version diagnostic for Settings -> Connection. Nothing is
 * persisted: the host announces its build version on `machine.hello` /
 * `machines.list`, the app knows its own from the installed binary, and the row is
 * recomputed on every render.
 *
 * Hosts predating the wire-up announce '0.0.0' (the field shipped but was
 * never fed a real version), and the machine mapper used 'muxr' as the
 * placeholder for a host that says nothing — both mean "unknown", and an
 * unknown host version must not raise a mismatch.
 */
export function knownHostVersion(hostVersion: string | undefined): string | undefined {
    const value = hostVersion?.trim();
    if (!value || value === '0.0.0' || !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(value)) return undefined;
    return value;
}

export function versionsMismatch(appVersion: string, hostVersion: string | undefined): boolean {
    const known = knownHostVersion(hostVersion);
    const app = knownHostVersion(appVersion);
    // Android uses the release's numeric versionName; npm retains its beta/dev suffix.
    return known !== undefined && app !== undefined && known.split(/[-+]/)[0] !== app.split(/[-+]/)[0];
}

export function applicationVersion(nativeVersion: string | null | undefined, expoVersion: string | null | undefined): string {
    return knownHostVersion(nativeVersion ?? undefined) ?? knownHostVersion(expoVersion ?? undefined) ?? 'unknown';
}
