import { accepted, rejected, type Result } from './result.js';

/** Native grants do not expire in practice. Browser grants last eight hours. */
export const DURABLE_GRANT_EXPIRES_AT = Date.UTC(9999, 11, 31, 23, 59, 59, 999);
export const BROWSER_GRANT_TTL_MS = 8 * 60 * 60_000;

export type ClientKind = 'native' | 'browser';
export type DeviceAuthority = 'control' | 'observe';

export function defaultAuthorityFor(kind: ClientKind): DeviceAuthority {
    return kind === 'browser' ? 'observe' : 'control';
}

export function parseClientKind(value: unknown): Result<ClientKind> {
    if (value === 'browser' || value === 'native') return accepted(value);
    return rejected('client kind must be native or browser');
}

export function parseDeviceAuthority(value: unknown): Result<DeviceAuthority> {
    if (value === 'control' || value === 'observe') return accepted(value);
    return rejected('device authority must be control or observe');
}

/**
 * Pairing intent owns grant lifetime and default authority.
 * Device Id later authorizes the grant; display names never do.
 */
export type PairingIntent = {
    kind: ClientKind;
    authority: DeviceAuthority;
    requiresWebHosting: boolean;
    grantExpiresAt: (now?: number) => number;
    refreshExpiresAt: (existingIso: string, now?: number) => number;
    matchesPending: (pending: { deviceKind?: unknown; authority?: unknown }) => boolean;
    deviceRecord: (fields: {
        deviceId: string;
        devicePublicKey: string;
        ingressKey: string;
        expiresAt: number;
    }) => Record<string, unknown>;
    pairingLocator: (relayUrl: string, code: string) => string;
    promptLine: () => string;
};

export function pairingIntent(input: { kind?: unknown; authority?: unknown }): PairingIntent {
    const kind: ClientKind = input.kind === 'browser' ? 'browser' : 'native';
    const requested = parseDeviceAuthority(input.authority);
    const authority: DeviceAuthority = kind === 'native'
        ? 'control'
        : requested.ok ? requested.value : defaultAuthorityFor(kind);
    return Object.freeze({
        kind,
        authority,
        requiresWebHosting: kind === 'browser',
        grantExpiresAt(now = Date.now()) {
            return kind === 'browser' ? now + BROWSER_GRANT_TTL_MS : DURABLE_GRANT_EXPIRES_AT;
        },
        refreshExpiresAt(existingIso: string, now = Date.now()) {
            if (kind !== 'browser') return DURABLE_GRANT_EXPIRES_AT;
            return Math.min(Date.parse(existingIso), now + BROWSER_GRANT_TTL_MS);
        },
        matchesPending(pending) {
            const pendingKind = pending.deviceKind === 'browser' ? 'browser' : 'native';
            const pendingAuthority = parseDeviceAuthority(pending.authority).ok
                ? (pending.authority as DeviceAuthority)
                : defaultAuthorityFor(pendingKind);
            return pendingKind === kind && pendingAuthority === authority;
        },
        deviceRecord({ deviceId, devicePublicKey, ingressKey, expiresAt }) {
            return {
                deviceId,
                devicePublicKey,
                ingressKey,
                expiresAt: new Date(expiresAt).toISOString(),
                authority,
                ...(kind === 'browser' ? { kind: 'browser' } : {}),
            };
        },
        pairingLocator(relayUrl, code) {
            const locator = new URL(relayUrl);
            locator.searchParams.set('pair', code);
            if (kind !== 'browser') return locator.toString();
            locator.protocol = 'https:';
            locator.pathname = '/pair';
            locator.searchParams.set('role', authority);
            return locator.toString();
        },
        promptLine() {
            if (kind !== 'browser') return 'Scan this pairing QR with the native app within two minutes:';
            const role = authority === 'observe' ? 'view-only' : 'control';
            return `Open this ${role} browser link within two minutes:`;
        },
    });
}

export function pairingIntentFromHostedFlags(args: readonly string[]): PairingIntent {
    const browser = args.includes('--browser') || args.includes('--browser-view');
    const observe = args.includes('--browser-view');
    return pairingIntent({ kind: browser ? 'browser' : 'native', authority: observe ? 'observe' : 'control' });
}

export function pairingIntentFromSelfhostFlags(args: readonly string[]): PairingIntent {
    const browser = args.includes('--pair-browser') || args.includes('--pair-browser-view');
    const observe = args.includes('--pair-browser-view');
    return pairingIntent({ kind: browser ? 'browser' : 'native', authority: observe ? 'observe' : 'control' });
}

export function pairingIntentFromDevice(device: { kind?: unknown; authority?: unknown }): PairingIntent {
    return pairingIntent({
        kind: device.kind === 'browser' ? 'browser' : 'native',
        authority: device.authority,
    });
}
