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
        if (this.kind() === 'browser') return Math.min(Date.parse(this.record.expiresAt), now + 8 * 60 * 60_000);
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

/** Browser/native observe grants. Peers use the peer admission path instead. */
export function observerGrantIsViewOnly(kind: string | undefined, canMutate: boolean): boolean {
    if (kind === 'peer') return false;
    return !canMutate;
}

export function grantMayAdministerPeers(kind: string | undefined, canMutate: boolean): boolean {
    if (kind === 'peer') return false;
    return canMutate;
}
