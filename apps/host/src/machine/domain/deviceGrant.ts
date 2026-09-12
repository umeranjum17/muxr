/**
 * Device Grant: keyed admission a phone, browser, or peer holds to a Machine.
 * Omitted kind on disk means native. Display labels never authorize.
 */

import type { PeerCapability } from '@muxr/contract';
import type { MachineCryptoState, MachineDeviceRecord } from './crypto.js';

export type DeviceKindName = 'native' | 'browser' | 'peer';
export type DeviceAuthorityName = 'control' | 'observe';

export class DeviceGrant {
    constructor(private readonly record: MachineDeviceRecord) {}

    static from(record: MachineDeviceRecord): DeviceGrant {
        return new DeviceGrant(record);
    }

    get deviceId(): string {
        return this.record.deviceId;
    }

    kind(): DeviceKindName {
        return this.record.kind ?? 'native';
    }

    authority(): DeviceAuthorityName {
        if (this.record.kind === 'peer') return 'observe';
        if (this.record.authority !== undefined) return this.record.authority;
        if (this.record.kind === 'browser') return 'observe';
        return 'control';
    }

    isPeer(): boolean {
        return this.record.kind === 'peer';
    }

    isLive(now: number): boolean {
        return Date.parse(this.record.expiresAt) > now;
    }

    canMutate(): boolean {
        return this.authority() !== 'observe';
    }

    static peerCount(devices: readonly MachineDeviceRecord[]): number {
        return devices.filter((device) => DeviceGrant.from(device).isPeer()).length;
    }

    static peerLimitReached(devices: readonly MachineDeviceRecord[], limit = 16): boolean {
        return DeviceGrant.peerCount(devices) >= limit;
    }

    grantExpiresAtMs(now: number, durableNativeExpiresAt: number): number {
        // Browser grants stay short-lived by default. The longer personal TTL
        // applies only when the stored device record carries the explicit
        // opt-in marker minted by `muxr pair --browser-personal` — installed
        // display-mode alone never implies it.
        if (this.kind() === 'browser') {
            const cap = this.record.personal === true ? 30 * 24 * 60 * 60_000 : 8 * 60 * 60_000;
            return Math.min(Date.parse(this.record.expiresAt), now + cap);
        }
        if (this.isPeer()) return Date.parse(this.record.expiresAt);
        return durableNativeExpiresAt;
    }

    sealedAudience(peerCapabilitiesFallback?: readonly PeerCapability[]): {
        deviceKind?: 'peer' | 'browser';
        authority?: DeviceAuthorityName;
        capabilities?: readonly PeerCapability[];
        allowedCwds?: readonly string[];
    } {
        if (this.isPeer()) {
            const capabilities = this.record.capabilities ?? peerCapabilitiesFallback;
            return {
                deviceKind: 'peer',
                ...(capabilities === undefined ? {} : { capabilities }),
                ...(this.record.allowedCwds === undefined ? {} : { allowedCwds: this.record.allowedCwds }),
            };
        }
        if (this.kind() === 'browser') return { deviceKind: 'browser', authority: this.authority() };
        return { authority: this.authority() };
    }
}

export function deviceKind(device: Pick<MachineDeviceRecord, 'kind'>): DeviceKindName {
    return DeviceGrant.from(device as MachineDeviceRecord).kind();
}

export function deviceAuthority(device: Pick<MachineDeviceRecord, 'kind' | 'authority'>): DeviceAuthorityName {
    return DeviceGrant.from(device as MachineDeviceRecord).authority();
}

export type HostedDeviceTables = {
    ingressKeys: Record<string, string>;
    deviceKinds: Record<string, DeviceKindName>;
    deviceAuthorities: Record<string, DeviceAuthorityName>;
    deviceDataKeys: Record<string, string>;
    deviceCapabilities: Record<string, readonly PeerCapability[]>;
    deviceAllowedCwds: Record<string, readonly string[]>;
    deviceExpiresAt: Record<string, number>;
};

export function deviceTablesFromCrypto(crypto: MachineCryptoState, now = Date.now()): HostedDeviceTables {
    const live = crypto.devices.filter((device) => DeviceGrant.from(device).isLive(now));
    const peers = crypto.devices.filter((device) => DeviceGrant.from(device).isPeer());
    return {
        ingressKeys: Object.fromEntries(live.map((device) => [device.deviceId, device.ingressKey])),
        deviceKinds: Object.fromEntries(crypto.devices.map((device) => [device.deviceId, deviceKind(device)])),
        deviceAuthorities: Object.fromEntries(crypto.devices.map((device) => [device.deviceId, deviceAuthority(device)])),
        deviceDataKeys: Object.fromEntries(peers.map((device) => [device.deviceId, device.dataKey!])),
        deviceCapabilities: Object.fromEntries(peers.map((device) => [device.deviceId, device.capabilities!])),
        deviceAllowedCwds: Object.fromEntries(
            crypto.devices.filter((device) => device.allowedCwds !== undefined).map((device) => [device.deviceId, device.allowedCwds!]),
        ),
        deviceExpiresAt: Object.fromEntries(crypto.devices.map((device) => [device.deviceId, Date.parse(device.expiresAt)])),
    };
}

export function applyDeviceTables(target: object, crypto: MachineCryptoState): void {
    Object.assign(target, deviceTablesFromCrypto(crypto));
}

export function deviceTableIsObserve(
    authorities: Readonly<Record<string, DeviceAuthorityName>> | undefined,
    deviceId: string | undefined,
): boolean {
    if (deviceId === undefined || authorities === undefined) return false;
    return authorities[deviceId] === 'observe';
}

export function deviceTableCanMutate(
    authorities: Readonly<Record<string, DeviceAuthorityName>> | undefined,
    deviceId: string,
): boolean {
    return authorities?.[deviceId] !== 'observe';
}

/**
 * Whether a device holds an explicitly live, unexpired, control-authority grant
 * on this machine right now.
 *
 * `deviceTableCanMutate` answers "not recorded as view-only", which is right
 * for the request gate but wrong for anything that has to survive a grant being
 * removed: removal leaves no authority entry, and an absent entry is not
 * permission. This asks the opposite question -- is there a grant, is it still
 * keyed, is it unexpired, is it a control grant -- and answers `false` for
 * every device it has no record of. Peers admit through their own path and hold
 * no surfaces.
 */
export function deviceTableHoldsControl(
    tables: {
        ingressKeys?: Readonly<Record<string, string>>;
        deviceKinds?: Readonly<Record<string, DeviceKindName>>;
        deviceAuthorities?: Readonly<Record<string, DeviceAuthorityName>>;
        deviceExpiresAt?: Readonly<Record<string, number>>;
    },
    deviceId: string,
    now = Date.now(),
): boolean {
    // A live grant keeps an ingress key; revoking one takes the key with it.
    if (tables.ingressKeys?.[deviceId] === undefined) return false;
    const expiresAt = tables.deviceExpiresAt?.[deviceId];
    if (expiresAt === undefined || !Number.isFinite(expiresAt) || expiresAt <= now) return false;
    const kind = tables.deviceKinds?.[deviceId];
    if (kind === undefined || kind === 'peer') return false;
    return tables.deviceAuthorities?.[deviceId] === 'control';
}

/** Browser/native observe grants. Peers use the peer admission path instead. */
export function observerGrantIsViewOnly(kind: string | undefined, canMutate: boolean): boolean {
    if (kind === 'peer') return false;
    return !canMutate;
}

export function grantMayAdministerPeers(kind: string | undefined, canMutate: boolean): boolean {
    if (kind === 'peer') return false;
    return canMutate;
}
