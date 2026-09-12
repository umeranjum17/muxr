import { accepted, rejected, type Result } from './result.js';

/** Native grants do not expire in practice. Browser grants last eight hours. */
export const DURABLE_GRANT_EXPIRES_AT = Date.UTC(9999, 11, 31, 23, 59, 59, 999);
export const BROWSER_GRANT_TTL_MS = 8 * 60 * 60_000;
/**
 * Explicit personal-browser grant lifetime (30 days, renewable by re-pairing).
 * Never the default: only `personal: true` intents mint it, and the host only
 * honors it when the stored device record carries the marker. Installed
 * display-mode alone never implies it.
 */
export const BROWSER_PERSONAL_GRANT_TTL_MS = 30 * 24 * 60 * 60_000;

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
    /** Explicit personal-browser opt-in. Never inferred from install state. */
    personal: boolean;
    requiresWebHosting: boolean;
    grantExpiresAt: (now?: number) => number;
    refreshExpiresAt: (existingIso: string, now?: number) => number;
    /** Human duration for consent copy ("eight hours" / "30 days"). */
    grantDurationLabel: () => string;
    matchesPending: (pending: { deviceKind?: unknown; authority?: unknown; personal?: unknown }) => boolean;
    deviceRecord: (fields: {
        deviceId: string;
        devicePublicKey: string;
        ingressKey: string;
        expiresAt: number;
    }) => Record<string, unknown>;
    pairingLocator: (relayUrl: string, code: string) => string;
    promptLine: () => string;
};

export function pairingIntent(input: { kind?: unknown; authority?: unknown; personal?: unknown }): PairingIntent {
    const kind: ClientKind = input.kind === 'browser' ? 'browser' : 'native';
    const requested = parseDeviceAuthority(input.authority);
    const authority: DeviceAuthority = kind === 'native'
        ? 'control'
        : requested.ok ? requested.value : defaultAuthorityFor(kind);
    const personal = kind === 'browser' && input.personal === true;
    const ttlMs = personal ? BROWSER_PERSONAL_GRANT_TTL_MS : BROWSER_GRANT_TTL_MS;
    return Object.freeze({
        kind,
        authority,
        personal,
        requiresWebHosting: kind === 'browser',
        grantExpiresAt(now = Date.now()) {
            return kind === 'browser' ? now + ttlMs : DURABLE_GRANT_EXPIRES_AT;
        },
        refreshExpiresAt(existingIso: string, now = Date.now()) {
            if (kind !== 'browser') return DURABLE_GRANT_EXPIRES_AT;
            return Math.min(Date.parse(existingIso), now + ttlMs);
        },
        grantDurationLabel() {
            if (kind !== 'browser') return 'until revoked';
            return personal ? '30 days' : 'eight hours';
        },
        matchesPending: (pending: { deviceKind?: unknown; authority?: unknown; personal?: unknown }) => {
            const pendingKind = pending.deviceKind === 'browser' ? 'browser' : 'native';
            const pendingAuthority = parseDeviceAuthority(pending.authority).ok
                ? (pending.authority as DeviceAuthority)
                : defaultAuthorityFor(pendingKind);
            return pendingKind === kind && pendingAuthority === authority
                && (pending.personal === true) === personal;
        },
        deviceRecord({ deviceId, devicePublicKey, ingressKey, expiresAt }) {
            return {
                deviceId,
                devicePublicKey,
                ingressKey,
                expiresAt: new Date(expiresAt).toISOString(),
                authority,
                ...(kind === 'browser' ? { kind: 'browser' } : {}),
                // The host refresh clamp honors the longer personal TTL only
                // when this marker is present on the stored record.
                ...(personal ? { personal: true } : {}),
            };
        },
        pairingLocator(relayUrl, code) {
            const locator = new URL(relayUrl);
            locator.searchParams.set('pair', code);
            if (kind !== 'browser') return locator.toString();
            locator.protocol = 'https:';
            locator.pathname = '/pair';
            locator.searchParams.set('role', authority);
            // Consent copy reads the lifetime from here; the host still decides it.
            if (personal) locator.searchParams.set('personal', '1');
            return locator.toString();
        },
        promptLine() {
            if (kind !== 'browser') return 'Scan this pairing QR with the native app within two minutes:';
            const role = authority === 'observe' ? 'view-only' : 'control';
            return `Scan this ${role} browser QR with your phone or tablet, or open the link, within two minutes:`;
        },
    });
}

export function pairingIntentFromHostedFlags(args: readonly string[]): PairingIntent {
    const browser = args.includes('--browser') || args.includes('--browser-view') || args.includes('--browser-personal');
    const observe = args.includes('--browser-view');
    const personal = args.includes('--browser-personal');
    return pairingIntent({ kind: browser ? 'browser' : 'native', authority: observe ? 'observe' : 'control', personal });
}

export function pairingIntentFromSelfhostFlags(args: readonly string[]): PairingIntent {
    const browser = args.includes('--pair-browser') || args.includes('--pair-browser-view') || args.includes('--pair-browser-personal');
    const observe = args.includes('--pair-browser-view');
    const personal = args.includes('--pair-browser-personal');
    return pairingIntent({ kind: browser ? 'browser' : 'native', authority: observe ? 'observe' : 'control', personal });
}

export function pairingIntentFromDevice(device: { kind?: unknown; authority?: unknown; personal?: unknown }): PairingIntent {
    return pairingIntent({
        kind: device.kind === 'browser' ? 'browser' : 'native',
        authority: device.authority,
        personal: device.personal,
    });
}
