import { pairingIntentFromDevice } from './pairing.js';
import { accepted, rejected, type Result } from './result.js';

export type AuthorityKind = 'hosted' | 'selfhost';

const CAPABILITIES = new Set(['list', 'read', 'status', 'watch', 'prompt', 'start']);

function asRecord(value: unknown): Record<string, unknown> | undefined {
    if (typeof value !== 'object' || value === null) return undefined;
    return value as Record<string, unknown>;
}

function validBase64(text: unknown, bytes: number): boolean {
    if (typeof text !== 'string' || text.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(text)) return false;
    try {
        return Buffer.from(text, 'base64').length === bytes;
    } catch {
        return false;
    }
}

function parseGrantBlob(text: unknown): Record<string, unknown> | undefined {
    if (typeof text !== 'string' || text.length === 0) return undefined;
    try {
        const grant = asRecord(JSON.parse(text));
        if (grant === undefined) return undefined;
        if (grant.v !== 1) return undefined;
        if (!validBase64(grant.sender, 32) || !validBase64(grant.signer, 32) || !validBase64(grant.sig, 64)) return undefined;
        if (typeof grant.box !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(grant.box)) return undefined;
        if (Buffer.from(grant.box, 'base64').length <= 40) return undefined;
        return grant;
    } catch {
        return undefined;
    }
}

function validCapabilities(capabilities: unknown): capabilities is string[] {
    if (!Array.isArray(capabilities) || capabilities.length === 0 || capabilities.length > 6) return false;
    if (new Set(capabilities).size !== capabilities.length) return false;
    return capabilities.every((capability) => typeof capability === 'string' && CAPABILITIES.has(capability));
}

function devicePasses(device: unknown): device is Record<string, unknown> {
    const record = asRecord(device);
    if (record === undefined) return false;
    if (typeof record.deviceId !== 'string' || record.deviceId.length === 0) return false;
    if (!validBase64(record.devicePublicKey, 32) || !validBase64(record.ingressKey, 32)) return false;
    if (typeof record.expiresAt !== 'string' || !Number.isFinite(Date.parse(record.expiresAt))) return false;
    if (record.kind !== undefined && typeof record.kind !== 'string') return false;
    const peer = record.kind === 'peer';
    if (record.kind !== undefined && record.kind !== 'browser' && !peer) {
        // A newer service may add device kinds before this CLI knows their
        // kind-specific fields. Validate the shared identity envelope and skip
        // the extension instead of declaring the whole machine corrupt.
        return true;
    }
    if (peer) {
        if (record.authority !== undefined) return false;
        if (!validBase64(record.dataKey, 32) || !validCapabilities(record.capabilities)) return false;
        if (record.capabilities.includes('start')) {
            return Array.isArray(record.allowedCwds) && record.allowedCwds.length > 0
                && record.allowedCwds.every((cwd) => typeof cwd === 'string' && cwd !== '');
        }
        return record.allowedCwds === undefined;
    }
    if (record.dataKey !== undefined || record.capabilities !== undefined || record.allowedCwds !== undefined) return false;
    return record.authority === undefined || record.authority === 'control' || record.authority === 'observe';
}

/**
 * A paired device. Device Id authorizes; display names on the relay list never do.
 */
export type Device = {
    deviceId: string;
    devicePublicKey: string;
    ingressKey: string;
    expiresAt: string;
    kind?: string | undefined;
    authority?: string | undefined;
    isPeer: boolean;
    isBrowser: boolean;
    pairing: ReturnType<typeof pairingIntentFromDevice>;
};

export function parseDevice(raw: unknown): Result<Device> {
    if (!devicePasses(raw)) return rejected('device record is invalid');
    return accepted({
        deviceId: raw.deviceId as string,
        devicePublicKey: raw.devicePublicKey as string,
        ingressKey: raw.ingressKey as string,
        expiresAt: raw.expiresAt as string,
        kind: typeof raw.kind === 'string' ? raw.kind : undefined,
        authority: typeof raw.authority === 'string' ? raw.authority : undefined,
        isPeer: raw.kind === 'peer',
        isBrowser: raw.kind === 'browser',
        pairing: pairingIntentFromDevice(raw),
    });
}

function pendingVersionIsValid(
    pending: Record<string, unknown>,
    currentVersion: number,
    rotationKind: string | undefined,
): boolean {
    const version = pending.keyVersion;
    if (rotationKind === undefined) {
        return Number.isInteger(version) && version === currentVersion + 1;
    }
    if (!Number.isInteger(pending.previousKeyVersion) || !Number.isInteger(version)) return false;
    if (version !== (pending.previousKeyVersion as number) + 1) return false;
    if (currentVersion !== pending.previousKeyVersion && currentVersion !== version) return false;
    return typeof pending.revokedDeviceId === 'string' && typeof pending.revokedDeviceName === 'string';
}

function grantsCoverDevices(
    pending: Record<string, unknown>,
    machine: Record<string, unknown>,
    rotationKind: string | undefined,
): boolean {
    const devices = pending.devices as Record<string, unknown>[];
    const grants = pending.grants as unknown[];
    const byId = new Map(devices.map((device) => [device.deviceId as string, device]));
    const expectedKeys = new Set(devices.map((device) => device.devicePublicKey as string));
    const seen = new Set<string>();
    for (const entry of grants) {
        const record = asRecord(entry);
        if (record === undefined) return false;
        const listed = rotationKind === undefined
            ? record.device_public_key
            : byId.get(record.deviceId as string)?.devicePublicKey ?? record.devicePublicKey;
        const grant = parseGrantBlob(record.grant);
        if (typeof listed !== 'string' || !expectedKeys.has(listed) || seen.has(listed) || grant === undefined) return false;
        if (grant.sender !== machine.boxPublicKey || grant.signer !== machine.signingPublicKey) return false;
        seen.add(listed);
    }
    return seen.size === expectedKeys.size;
}

export function parseMachineCrypto(value: unknown, expected: AuthorityKind): Result<Record<string, unknown>> {
    const machine = asRecord(value);
    if (machine === undefined) return rejected('machine crypto is missing');
    const keys = validBase64(machine.signingPublicKey, 32)
        && validBase64(machine.signingSecretKey, 64)
        && validBase64(machine.boxPublicKey, 32)
        && validBase64(machine.boxSecretKey, 32)
        && validBase64(machine.dataKey, 32);
    if (!keys || !Number.isInteger(machine.keyVersion) || (machine.keyVersion as number) < 1) {
        return rejected('machine keys are incomplete');
    }
    if (!Array.isArray(machine.devices) || !machine.devices.every(devicePasses)) {
        return rejected('paired devices are invalid');
    }
    const deviceIds = machine.devices.map((device) => (device as { deviceId: string }).deviceId);
    if (new Set(deviceIds).size !== deviceIds.length) return rejected('device ids must be unique');
    const pending = machine.pendingRotation;
    if (pending === undefined) return accepted(machine);
    const rotation = asRecord(pending);
    if (rotation === undefined) return rejected('pending rotation is invalid');
    if (!validBase64(rotation.dataKey, 32) || !Array.isArray(rotation.devices) || !rotation.devices.every(devicePasses)) {
        return rejected('pending rotation devices are invalid');
    }
    const pendingIds = rotation.devices.map((device) => (device as { deviceId: string }).deviceId);
    if (new Set(pendingIds).size !== pendingIds.length) return rejected('pending rotation device ids must be unique');
    if (!Array.isArray(rotation.grants) || rotation.grants.length !== rotation.devices.length) {
        return rejected('pending rotation grants do not match devices');
    }
    const kind = rotation.kind;
    const peer = kind === 'peer-revoke-v1';
    const selfhost = kind === 'selfhost-revoke-v1';
    if (kind !== undefined && !peer && !selfhost) return rejected('unknown pending rotation kind');
    if (kind === undefined && expected !== 'hosted') return rejected('hosted rotation kind is required');
    if (selfhost && expected !== 'selfhost') return rejected('self-host rotation kind is required');
    if (peer && rotation.authorityKind !== expected) return rejected('peer rotation authority kind mismatch');
    if (!pendingVersionIsValid(rotation, machine.keyVersion as number, typeof kind === 'string' ? kind : undefined)) {
        return rejected('pending rotation key version is invalid');
    }
    if (!grantsCoverDevices(rotation, machine, typeof kind === 'string' ? kind : undefined)) {
        return rejected('pending rotation grants are incomplete');
    }
    return accepted(machine);
}

export function validMachineCrypto(value: unknown, expected: AuthorityKind): boolean {
    return parseMachineCrypto(value, expected).ok;
}
