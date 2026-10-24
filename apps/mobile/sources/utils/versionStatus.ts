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

export type BuildChannel = 'stable' | 'nightly' | 'pre-release' | 'preview' | 'development';

/**
 * The build's channel comes from what it was built as: the release workflow's
 * exact identity (`0.2.14-nightly.1.1`, `0.2.14-rc.1`) and the APP_ENV variant
 * baked into the app config. A build that predates the variant field is a
 * store build and reads as stable.
 */
export function appBuild(version: string, releaseVersion: string | undefined, variant: string | undefined): { channel: BuildChannel; label: string } {
    const release = knownHostVersion(releaseVersion);
    const identity = release !== undefined && release.split(/[-+]/)[0] === version.split(/[-+]/)[0] ? release : version;
    const tag = identity.split('-')[1];
    if (tag?.startsWith('nightly')) return { channel: 'nightly', label: identity };
    if (tag !== undefined) return { channel: 'pre-release', label: `${identity} pre-release` };
    if (variant === 'development') return { channel: 'development', label: `${identity}-dev` };
    if (variant === 'preview') return { channel: 'preview', label: `${identity} preview` };
    return { channel: 'stable', label: identity };
}

/** One line for the app and its computer, e.g. `App 0.2.13 · Host 0.2.10`. */
export function versionPairLine(appLabel: string, hostVersion: string | undefined): string {
    const host = knownHostVersion(hostVersion);
    return host === undefined ? `App ${appLabel}` : `App ${appLabel} · Host ${host}`;
}
