import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, watchFile, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { createDeviceGrant } from '@muxr/crypto';
import { isPeerCapabilities, relayControlUrl } from '@muxr/contract';
import { homedir, hostname } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertFakeSourceCoversContract, createFakeSessionSource } from './fakeSessionSource.js';
import { startHost } from './host.js';
import { createHerdrSessionSource } from './herdr/herdrSessionSource.js';
import { IdentityStore } from './herdr/identity.js';
import { TerminalManager } from './herdr/terminalManager.js';
import { createDomainStores } from './domain/index.js';
import { createPersistQueue } from './domain/persistedJson.js';
import { HttpPeerAuthority } from './peer/authority.js';
import { PeerBroker } from './peer/broker.js';
import { PeerRuntime } from './peer/runtime.js';
import type { MachineCryptoState } from './peer/types.js';

const DURABLE_GRANT_EXPIRES_AT = Date.UTC(9999, 11, 31, 23, 59, 59, 999);
function env(name: string): string | undefined {
    return process.env[name]?.trim() || undefined;
}

function defaultDataDir(): string {
    return join(homedir(), '.muxr', 'host');
}

/**
 * The product/build version this host belongs to. The published artifact
 * bundles the host to a host.js beside the @trymuxr/cli package.json; in the
 * monorepo the workspace manifests are all 0.0.0 and the version lives at the
 * root. Walk up to the first manifest with a real version.
 */
function resolveHostVersion(): string | undefined {
    let dir = dirname(fileURLToPath(import.meta.url));
    for (let depth = 0; depth < 5; depth++) {
        try {
            const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { version?: unknown };
            if (typeof manifest.version === 'string' && manifest.version !== '0.0.0') return manifest.version;
        } catch {
            // No manifest here — keep walking.
        }
        const parent = dirname(dir);
        if (parent === dir) return undefined;
        dir = parent;
    }
    return undefined;
}

class NonRecoverableAuthError extends Error {}
class HostedAuthExpiredError extends NonRecoverableAuthError {}

interface HostedAuthState {
    version: 1;
    controlUrl: string;
    relayUrl: string;
    credential: string;
    credentialExpiresAt: string;
    machine: {
        id: string;
        name?: string;
        crypto?: MachineCryptoState;
    };
}

function validBase64(value: unknown, bytes: number): boolean {
    if (typeof value !== 'string' || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return false;
    try { return Buffer.from(value, 'base64').length === bytes; }
    catch { return false; }
}

function parseSealedGrant(value: unknown): Record<string, unknown> | undefined {
    if (typeof value !== 'string' || value.length === 0) return undefined;
    try {
        const grant = JSON.parse(value) as Record<string, unknown>;
        return grant.v === 1
            && validBase64(grant.sender, 32)
            && validBase64(grant.signer, 32)
            && validBase64(grant.sig, 64)
            && typeof grant.box === 'string'
            && /^[A-Za-z0-9+/]+={0,2}$/.test(grant.box)
            && Buffer.from(grant.box, 'base64').length > 40
            ? grant : undefined;
    } catch { return undefined; }
}

function validDevice(value: unknown): boolean {
    if (typeof value !== 'object' || value === null) return false;
    const device = value as Record<string, unknown>;
    const peer = device.kind === 'peer';
    return typeof device.deviceId === 'string' && device.deviceId.length > 0
        && validBase64(device.devicePublicKey, 32)
        && validBase64(device.ingressKey, 32)
        && typeof device.expiresAt === 'string' && Number.isFinite(Date.parse(device.expiresAt))
        && (device.kind === undefined || device.kind === 'browser' || peer)
        && (peer ? device.authority === undefined && validBase64(device.dataKey, 32) && isPeerCapabilities(device.capabilities)
            : device.dataKey === undefined && device.capabilities === undefined && device.allowedCwds === undefined
                && (device.authority === undefined || device.authority === 'control' || device.authority === 'observe'))
        && (!peer || ((device.capabilities as string[]).includes('start')
            ? Array.isArray(device.allowedCwds) && device.allowedCwds.length > 0
                && device.allowedCwds.every((cwd) => typeof cwd === 'string' && cwd !== '')
            : device.allowedCwds === undefined));
}

function validMachineCrypto(value: unknown, expected: 'hosted' | 'selfhost'): value is MachineCryptoState {
    if (typeof value !== 'object' || value === null) return false;
    const crypto = value as Partial<MachineCryptoState>;
    const keys = validBase64(crypto.signingPublicKey, 32)
        && validBase64(crypto.signingSecretKey, 64)
        && validBase64(crypto.boxPublicKey, 32)
        && validBase64(crypto.boxSecretKey, 32)
        && validBase64(crypto.dataKey, 32);
    if (!keys || !Number.isInteger(crypto.keyVersion) || crypto.keyVersion! < 1
        || !Array.isArray(crypto.devices) || !crypto.devices.every(validDevice)
        || new Set(crypto.devices.map((device) => device.deviceId)).size !== crypto.devices.length) return false;
    const pending = crypto.pendingRotation as unknown as Record<string, unknown> | undefined;
    if (pending === undefined) return true;
    const devices = pending.devices;
    const grants = pending.grants;
    if (!validBase64(pending.dataKey, 32) || !Array.isArray(devices) || !devices.every(validDevice)
        || new Set(devices.map((device) => device.deviceId)).size !== devices.length || !Array.isArray(grants)
        || grants.length !== devices.length || !Number.isInteger(pending.keyVersion)) return false;
    const kind = pending.kind;
    const peer = kind === 'peer-revoke-v1';
    const selfhost = kind === 'selfhost-revoke-v1';
    if (kind !== undefined && !peer && !selfhost) return false;
    if (kind === undefined && expected !== 'hosted') return false;
    if (selfhost && expected !== 'selfhost') return false;
    if (peer && pending.authorityKind !== expected) return false;
    const previous = pending.previousKeyVersion;
    const version = pending.keyVersion as number;
    if (kind === undefined ? version !== crypto.keyVersion! + 1
        : !Number.isInteger(previous) || version !== (previous as number) + 1
            || crypto.keyVersion !== previous && crypto.keyVersion !== version
            || typeof pending.revokedDeviceId !== 'string' || typeof pending.revokedDeviceName !== 'string') return false;
    const byId = new Map(devices.map((device) => [device.deviceId, device]));
    const expectedKeys = new Set(devices.map((device) => device.devicePublicKey));
    const seen = new Set<string>();
    return grants.every((entry) => {
        if (typeof entry !== 'object' || entry === null) return false;
        const candidate = entry as Record<string, unknown>;
        const deviceKey = kind === undefined
            ? candidate.device_public_key
            : byId.get(candidate.deviceId)?.devicePublicKey ?? candidate.devicePublicKey;
        const sealed = parseSealedGrant(candidate.grant);
        if (typeof deviceKey !== 'string' || !expectedKeys.has(deviceKey) || seen.has(deviceKey) || sealed === undefined
            || sealed.sender !== crypto.boxPublicKey || sealed.signer !== crypto.signingPublicKey) return false;
        seen.add(deviceKey);
        return true;
    }) && seen.size === expectedKeys.size;
}

interface SelfhostState {
    version: 1;
    relayPort?: number;
    relayUrl?: string;
    mintSecret?: string;
    machineCredential?: string;
    credentialExpiresAt?: string;
    relayLocation?: 'local' | 'remote';
    machine: { id: string; name?: string; crypto: MachineCryptoState };
}

function selfhostFile(): string {
    return join(env('MUXR_HOME') ?? join(homedir(), '.muxr'), 'selfhost.json');
}

function readSelfhostAuth(): SelfhostState | undefined {
    const path = selfhostFile();
    if (!existsSync(path)) return undefined;
    const info = lstatSync(path);
    if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077) !== 0) {
        throw new NonRecoverableAuthError(`${path} must be a regular owner-only file`);
    }
    let parsed: Partial<SelfhostState>;
    try { parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<SelfhostState>; }
    catch (error) {
        if (error instanceof SyntaxError) throw new NonRecoverableAuthError(`${path} contains malformed JSON`);
        if ((error as NodeJS.ErrnoException)?.code === 'EACCES' || (error as NodeJS.ErrnoException)?.code === 'EPERM') {
            throw new NonRecoverableAuthError(`${path} cannot be read; restore owner read permission and run \`muxr doctor\``);
        }
        throw error;
    }
    if (parsed.version !== 1 || typeof parsed.machine?.id !== 'string' || !validMachineCrypto(parsed.machine.crypto, 'selfhost')
        || typeof parsed.mintSecret !== 'string' && typeof parsed.machineCredential !== 'string'
        || parsed.relayLocation === 'remote' && typeof parsed.relayUrl !== 'string'
        || parsed.relayLocation !== 'remote' && typeof parsed.relayPort !== 'number') {
        throw new NonRecoverableAuthError(`${path} has an unsupported or incomplete schema`);
    }
    if (parsed.credentialExpiresAt !== undefined) {
        const expires = Date.parse(parsed.credentialExpiresAt);
        if (!Number.isFinite(expires)) throw new NonRecoverableAuthError(`${path} has an invalid credential expiry`);
        if (expires <= Date.now()) throw new HostedAuthExpiredError('remote relay machine credential expired; create a fresh enrollment from the relay owner');
    }
    return parsed as SelfhostState;
}

function authFile(): string {
    return join(env('MUXR_HOME') ?? join(homedir(), '.muxr'), 'auth.json');
}

function readHostedAuth(): HostedAuthState | undefined {
    const path = authFile();
    if (!existsSync(path)) return undefined;
    const info = lstatSync(path);
    if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077) !== 0) {
        throw new NonRecoverableAuthError(`${path} must be a regular owner-only file`);
    }
    let parsed: Partial<HostedAuthState>;
    try { parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<HostedAuthState>; }
    catch (error) {
        if (error instanceof SyntaxError) throw new NonRecoverableAuthError(`${path} contains malformed JSON`);
        if ((error as NodeJS.ErrnoException)?.code === 'EACCES' || (error as NodeJS.ErrnoException)?.code === 'EPERM') {
            throw new NonRecoverableAuthError(`${path} cannot be read; restore owner read permission and run \`muxr doctor\``);
        }
        throw error;
    }
    if (parsed.version !== 1 || typeof parsed.controlUrl !== 'string' || typeof parsed.relayUrl !== 'string' || typeof parsed.credential !== 'string'
        || typeof parsed.credentialExpiresAt !== 'string' || !Number.isFinite(Date.parse(parsed.credentialExpiresAt))
        || typeof parsed.machine?.id !== 'string' || !validMachineCrypto(parsed.machine.crypto, 'hosted')) {
        throw new NonRecoverableAuthError(`${path} has an unsupported or incomplete schema`);
    }
    if (Date.parse(parsed.credentialExpiresAt) <= Date.now()) throw new HostedAuthExpiredError('hosted machine credential expired; run `muxr login`');
    return parsed as HostedAuthState;
}

type ReplaySnapshots = Record<string, { epochs: Array<{ epoch: string; maxSeq: number }> }>;

function readReplaySnapshots(path: string): ReplaySnapshots {
    if (!existsSync(path)) return {};
    const info = lstatSync(path);
    if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077) !== 0) throw new Error(`${path} must be a regular owner-only file`);
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('hosted replay state is malformed');
    return parsed as ReplaySnapshots;
}

function atomicWriteJson(path: string, value: unknown): void {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const temporary = `${path}.tmp-${process.pid}`;
    writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    chmodSync(temporary, 0o600);
    renameSync(temporary, path);
}

function writeHostedAuth(auth: HostedAuthState): void {
    atomicWriteJson(authFile(), auth);
}

function writeSelfhostAuth(auth: SelfhostState): void {
    atomicWriteJson(selfhostFile(), auth);
}

async function reconcileHostedKeys(auth: HostedAuthState): Promise<void> {
    const crypto = auth.machine.crypto;
    if (crypto === undefined) throw new Error('hosted machine keys are missing; re-register and re-pair this machine');
    const response = await fetch(`${auth.controlUrl}/v1/machines/${encodeURIComponent(auth.machine.id)}/keys`, {
        headers: { authorization: `Bearer ${auth.credential}` },
        signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error(`hosted key-state check failed (${response.status})`);
    const state = await response.json() as {
        key_version: number;
        rotation_pending: boolean;
        devices: Array<{ device_id: string; device_public_key: string }>;
    };
    const promote = (): void => {
        const pending = crypto.pendingRotation;
        if (pending === undefined) throw new Error('hosted key rotation recovery state is missing');
        crypto.dataKey = pending.dataKey;
        crypto.keyVersion = pending.keyVersion;
        crypto.devices = pending.devices;
        delete crypto.pendingRotation;
        writeHostedAuth(auth);
    };
    const submitPending = async (): Promise<void> => {
        const pending = crypto.pendingRotation;
        if (pending === undefined) throw new Error('hosted key rotation recovery state is missing');
        const rotated = await fetch(`${auth.controlUrl}/v1/machines/${encodeURIComponent(auth.machine.id)}/keys/rotate`, {
            method: 'POST',
            headers: { authorization: `Bearer ${auth.credential}`, 'content-type': 'application/json' },
            body: JSON.stringify({ grants: pending.grants }),
            signal: AbortSignal.timeout(15_000),
        });
        if (!rotated.ok) throw new Error(`hosted key rotation failed (${rotated.status})`);
        promote();
    };

    if (crypto.pendingRotation !== undefined) {
        if (!state.rotation_pending && state.key_version === crypto.pendingRotation.keyVersion) {
            // The server committed but its response was lost. Promote the exact
            // locally persisted candidate; never ask the relay to reconstruct it.
            promote();
            return;
        }
        if (!state.rotation_pending || state.key_version !== crypto.keyVersion) {
            throw new Error('hosted key rotation recovery state does not match the control plane');
        }
        const expected = new Map(crypto.pendingRotation.devices.map((device) => [device.deviceId, device.devicePublicKey]));
        if (state.devices.length !== expected.size || state.devices.some((device) => expected.get(device.device_id) !== device.device_public_key)) {
            throw new Error('hosted key rotation changed while a commit was pending; refusing substitution');
        }
        await submitPending();
        return;
    }

    if (!state.rotation_pending) {
        if (state.key_version !== crypto.keyVersion) throw new Error('hosted key version mismatch; re-pair this machine');
        return;
    }
    if (state.key_version !== crypto.keyVersion) throw new Error('hosted key-state version mismatch; refusing relay-directed rotation');
    const localDevices = new Map(crypto.devices.map((device) => [device.deviceId, device]));
    const seen = new Set<string>();
    for (const device of state.devices) {
        const local = localDevices.get(device.device_id);
        if (local === undefined || local.devicePublicKey !== device.device_public_key || seen.has(device.device_id)) {
            throw new Error('hosted key rotation rejected an unpaired or substituted device');
        }
        seen.add(device.device_id);
    }
    const nextVersion = crypto.keyVersion + 1;
    const dataKey = randomBytes(32).toString('base64');
    const nextDevices = state.devices.map((device) => {
        const ingressKey = randomBytes(32).toString('base64');
        const existing = localDevices.get(device.device_id)!;
        const expiresAt = existing.kind === 'browser'
            ? Math.min(Date.parse(existing.expiresAt), Date.now() + 8 * 60 * 60_000)
            : existing.kind === 'peer' ? Date.parse(existing.expiresAt) : DURABLE_GRANT_EXPIRES_AT;
        const peerDataKey = existing.kind === 'peer' ? randomBytes(32).toString('base64') : undefined;
        const local = {
            ...existing,
            deviceId: device.device_id,
            devicePublicKey: device.device_public_key,
            ingressKey,
            expiresAt: new Date(expiresAt).toISOString(),
            ...(peerDataKey === undefined ? {} : { dataKey: peerDataKey }),
        };
        return {
            local,
            upload: {
                device_public_key: device.device_public_key,
                grant: JSON.stringify(createDeviceGrant({
                    machineId: auth.machine.id,
                    machineSigningSecretKey: crypto.signingSecretKey,
                    machineKey: { publicKey: crypto.boxPublicKey, secretKey: crypto.boxSecretKey },
                    deviceId: device.device_id,
                    devicePublicKey: device.device_public_key,
                    dataKey: peerDataKey ?? dataKey,
                    ingressKey,
                    keyVersion: nextVersion,
                    expiresAt,
                    ...(existing.kind === 'peer' ? {
                        deviceKind: 'peer' as const,
                        capabilities: existing.capabilities!,
                        ...(existing.allowedCwds === undefined ? {} : { allowedCwds: existing.allowedCwds }),
                    } : {
                        ...(existing.kind === 'browser' ? { deviceKind: 'browser' as const } : {}),
                        authority: existing.authority ?? (existing.kind === 'browser' ? 'observe' as const : 'control' as const),
                    }),
                })),
            },
        };
    });
    // Persist the exact candidate before the network commit. A lost response is
    // then recoverable and cannot leave local/server key versions permanently split.
    crypto.pendingRotation = {
        keyVersion: nextVersion,
        dataKey,
        devices: nextDevices.map((entry) => entry.local),
        grants: nextDevices.map((entry) => entry.upload),
    };
    writeHostedAuth(auth);
    await submitPending();
}

function readAuthStates() {
    try { return { hostedAuth: readHostedAuth(), selfhostAuth: readSelfhostAuth() }; }
    catch (error) {
        process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
        // Deterministic auth faults cannot heal by restarting. Transient I/O
        // errors remain failures so the service manager may retry.
        const code = (error as NodeJS.ErrnoException)?.code;
        process.exit(error instanceof NonRecoverableAuthError || code === 'EACCES' || code === 'EPERM' ? 0 : 1);
    }
}
const { hostedAuth, selfhostAuth } = readAuthStates();
const relayUrl = env('MUXR_RELAY_URL') ?? hostedAuth?.relayUrl
    ?? (selfhostAuth?.relayLocation === 'remote' ? selfhostAuth.relayUrl : undefined)
    ?? (selfhostAuth?.relayPort === undefined ? undefined : `ws://127.0.0.1:${selfhostAuth.relayPort}/relay`)
    ?? 'ws://127.0.0.1:8792';
const machineId = env('MUXR_MACHINE_ID') ?? hostedAuth?.machine.id ?? selfhostAuth?.machine.id ?? hostname();
const machineName = env('MUXR_MACHINE_NAME') ?? hostedAuth?.machine.name ?? selfhostAuth?.machine.name ?? hostname();
const dataDir = env('MUXR_DATA_DIR') ?? defaultDataDir();
const stateRoot = dirname(dataDir);
const useFake = process.argv.includes('--fake');
const requestedMode = env('MUXR_MODE')?.toLowerCase();
if (requestedMode !== undefined && requestedMode !== 'hosted' && requestedMode !== 'local' && requestedMode !== 'selfhost') {
    throw new Error('MUXR_MODE must be hosted, selfhost, or local');
}
const mode = requestedMode ?? (hostedAuth !== undefined ? 'hosted' : selfhostAuth !== undefined ? 'selfhost' : useFake ? 'local' : undefined);
if (mode === undefined) throw new Error('no hosted auth state; set MUXR_MODE=local explicitly for development');
const token = env('MUXR_RELAY_TOKEN') ?? (mode === 'hosted' ? hostedAuth?.credential : mode === 'selfhost' ? selfhostAuth?.machineCredential ?? selfhostAuth?.mintSecret : undefined);
if (mode === 'hosted' && hostedAuth === undefined) {
    process.stderr.write('hosted mode requires muxr setup/login state; run `muxr doctor`\n');
    process.exit(0);
}
if (mode === 'selfhost' && selfhostAuth === undefined) {
    process.stderr.write('selfhost mode requires muxr setup state; run `muxr doctor`\n');
    process.exit(0);
}

async function main(): Promise<void> {
    if (mode === 'hosted' && hostedAuth!.machine.crypto?.pendingRotation?.kind !== 'peer-revoke-v1') {
        await reconcileHostedKeys(hostedAuth!);
    }
    const machineCrypto = mode === 'hosted' ? hostedAuth?.machine.crypto
        : mode === 'selfhost' ? selfhostAuth?.machine.crypto : undefined;
    const replayPath = join(dataDir, 'replay-v2.json');
    const replayPersist = createPersistQueue(replayPath);
    const replaySnapshots = machineCrypto !== undefined ? readReplaySnapshots(replayPath) : {};
    const hostedE2ee = machineCrypto === undefined ? undefined : {
        machineId,
        keyVersion: machineCrypto.keyVersion,
        dataKey: machineCrypto.dataKey,
        ingressKeys: Object.fromEntries(
            machineCrypto.devices
                .filter((device) => Date.parse(device.expiresAt) > Date.now())
                .map((device) => [device.deviceId, device.ingressKey]),
        ),
        deviceKinds: Object.fromEntries(
            machineCrypto.devices.map((device) => [device.deviceId, device.kind ?? 'native' as const]),
        ),
        deviceAuthorities: Object.fromEntries(
            machineCrypto.devices.map((device) => [device.deviceId, device.kind === 'peer' ? 'observe' as const
                : device.authority ?? (device.kind === 'browser' ? 'observe' as const : 'control' as const)]),
        ),
        deviceDataKeys: Object.fromEntries(
            machineCrypto.devices.filter((device) => device.kind === 'peer').map((device) => [device.deviceId, device.dataKey!]),
        ),
        deviceCapabilities: Object.fromEntries(
            machineCrypto.devices.filter((device) => device.kind === 'peer').map((device) => [device.deviceId, device.capabilities!]),
        ),
        deviceAllowedCwds: Object.fromEntries(
            machineCrypto.devices.filter((device) => device.allowedCwds !== undefined).map((device) => [device.deviceId, device.allowedCwds!]),
        ),
        deviceExpiresAt: Object.fromEntries(
            machineCrypto.devices.map((device) => [device.deviceId, Date.parse(device.expiresAt)]),
        ),
        replaySnapshots,
        onReplayChange: (snapshots: ReplaySnapshots) => {
            Object.assign(replaySnapshots, snapshots);
            replayPersist.schedule(replaySnapshots);
        },
    };
    if ((mode === 'selfhost' || mode === 'hosted') && hostedE2ee !== undefined) {
        // Pairing is a separate CLI process. Reload its appended per-device
        // ingress key without making an already-running host restart.
        const keys = hostedE2ee;
        const stateFile = mode === 'selfhost' ? selfhostFile() : authFile();
        watchFile(stateFile, { interval: 2000 }, () => {
            try {
                const crypto = mode === 'selfhost' ? readSelfhostAuth()?.machine.crypto : readHostedAuth()?.machine.crypto;
                if (crypto === undefined || crypto.keyVersion < keys.keyVersion
                    || (crypto.keyVersion === keys.keyVersion && crypto.dataKey !== keys.dataKey)) return;
                if (mode === 'hosted') hostedAuth!.machine.crypto = crypto;
                else selfhostAuth!.machine.crypto = crypto;
                if (crypto.keyVersion > keys.keyVersion) {
                    keys.keyVersion = crypto.keyVersion;
                    keys.dataKey = crypto.dataKey;
                    for (const replayKey of Object.keys(replaySnapshots)) delete replaySnapshots[replayKey];
                    replayPersist.schedule(replaySnapshots);
                }
                keys.ingressKeys = Object.fromEntries(
                    crypto.devices
                        .filter((device) => Date.parse(device.expiresAt) > Date.now())
                        .map((device) => [device.deviceId, device.ingressKey]),
                );
                keys.deviceKinds = Object.fromEntries(
                    crypto.devices.map((device) => [device.deviceId, device.kind ?? 'native' as const]),
                );
                keys.deviceAuthorities = Object.fromEntries(
                    crypto.devices.map((device) => [device.deviceId, device.kind === 'peer' ? 'observe' as const
                        : device.authority ?? (device.kind === 'browser' ? 'observe' as const : 'control' as const)]),
                );
                keys.deviceDataKeys = Object.fromEntries(
                    crypto.devices.filter((device) => device.kind === 'peer').map((device) => [device.deviceId, device.dataKey!]),
                );
                keys.deviceCapabilities = Object.fromEntries(
                    crypto.devices.filter((device) => device.kind === 'peer').map((device) => [device.deviceId, device.capabilities!]),
                );
                keys.deviceAllowedCwds = Object.fromEntries(
                    crypto.devices.filter((device) => device.allowedCwds !== undefined).map((device) => [device.deviceId, device.allowedCwds!]),
                );
                keys.deviceExpiresAt = Object.fromEntries(
                    crypto.devices.map((device) => [device.deviceId, Date.parse(device.expiresAt)]),
                );
            } catch {
                // Keep serving with the last fully validated key set.
            }
        });
    }
    let peerRuntime: PeerRuntime | undefined;
    let peerBroker: PeerBroker | undefined;
    if ((mode === 'selfhost' || mode === 'hosted') && hostedE2ee !== undefined && token !== undefined) {
        const cryptoAdapter = {
            get: (): MachineCryptoState => (mode === 'hosted' ? hostedAuth!.machine.crypto! : selfhostAuth!.machine.crypto),
            commit: async (next: MachineCryptoState): Promise<void> => {
                if (mode === 'hosted') {
                    hostedAuth!.machine.crypto = next;
                    writeHostedAuth(hostedAuth!);
                } else {
                    selfhostAuth!.machine.crypto = next;
                    writeSelfhostAuth(selfhostAuth!);
                }
                if (next.keyVersion !== hostedE2ee.keyVersion || next.dataKey !== hostedE2ee.dataKey) {
                    hostedE2ee.keyVersion = next.keyVersion;
                    hostedE2ee.dataKey = next.dataKey;
                    for (const replayKey of Object.keys(replaySnapshots)) delete replaySnapshots[replayKey];
                    replayPersist.schedule(replaySnapshots);
                }
                hostedE2ee.ingressKeys = Object.fromEntries(next.devices
                    .filter((device) => Date.parse(device.expiresAt) > Date.now())
                    .map((device) => [device.deviceId, device.ingressKey]));
                hostedE2ee.deviceKinds = Object.fromEntries(next.devices.map((device) => [device.deviceId, device.kind ?? 'native' as const]));
                hostedE2ee.deviceAuthorities = Object.fromEntries(next.devices.map((device) => [device.deviceId,
                    device.kind === 'peer' ? 'observe' as const : device.authority ?? (device.kind === 'browser' ? 'observe' as const : 'control' as const)]));
                hostedE2ee.deviceDataKeys = Object.fromEntries(next.devices.filter((device) => device.kind === 'peer')
                    .map((device) => [device.deviceId, device.dataKey!]));
                hostedE2ee.deviceCapabilities = Object.fromEntries(next.devices.filter((device) => device.kind === 'peer')
                    .map((device) => [device.deviceId, device.capabilities!]));
                hostedE2ee.deviceAllowedCwds = Object.fromEntries(next.devices.filter((device) => device.allowedCwds !== undefined)
                    .map((device) => [device.deviceId, device.allowedCwds!]));
                hostedE2ee.deviceExpiresAt = Object.fromEntries(next.devices.map((device) => [device.deviceId, Date.parse(device.expiresAt)]));
            },
        };
        try {
            peerRuntime = new PeerRuntime({
                dataDir: join(dataDir, 'peer'),
                machineId,
                machineName,
                platform: process.platform === 'darwin' ? 'macOS' : process.platform === 'win32' ? 'Windows' : process.platform === 'linux' ? 'Linux' : process.platform,
                relayUrl,
                crypto: cryptoAdapter,
                authority: new HttpPeerAuthority({
                    kind: mode,
                    controlUrl: mode === 'hosted' ? hostedAuth!.controlUrl : relayControlUrl(relayUrl),
                    machineId,
                    credential: token,
                }),
            });
        } catch (error) {
            process.stderr.write(`peer runtime unavailable: ${error instanceof Error ? error.message : String(error)}\n`);
        }
        if (peerRuntime !== undefined) {
            void peerRuntime.recover().catch((error) => {
                process.stderr.write(`peer recovery pending: ${error instanceof Error ? error.message : String(error)}\n`);
            });
            try {
                peerBroker = new PeerBroker(join(dataDir, 'peer', 'voice.sock'), peerRuntime);
                await peerBroker.start();
            } catch (error) {
                await peerBroker?.close().catch(() => undefined);
                peerBroker = undefined;
                process.stderr.write(`peer voice broker unavailable: ${error instanceof Error ? error.message : String(error)}\n`);
            }
        }
    }
    const domain = createDomainStores({ dataDir });
    const identity = new IdentityStore(dataDir);
    const terminals = new TerminalManager({
        relayUrl,
        machineId,
        identity,
        ...(token === undefined ? {} : { token }),
        ...(process.env.HERDR_BIN === undefined ? {} : { herdrBin: process.env.HERDR_BIN }),
        ...(hostedE2ee === undefined ? {} : { hostedE2ee }),
    });
    const source = useFake
        ? (assertFakeSourceCoversContract(), createFakeSessionSource())
        : await createHerdrSessionSource({
              dataDir,
              attention: domain.attention,
              identity,
              relayUrl,
              machineId,
              attachmentsDir: join(stateRoot, 'attachments', 'pane'),
              hostHttpPort: Number(env('MUXR_HOST_HTTP_PORT') ?? 8793),
              ...(token === undefined ? {} : { token }),
              ...(hostedE2ee === undefined ? {} : { hostedE2ee }),
              ...(peerBroker === undefined ? {} : { peerBroker }),
          });

    const hostVersion = resolveHostVersion();
    startHost({
        ...(hostedE2ee === undefined ? {} : { hostedE2ee }),
        ...(token === undefined ? {} : { token }),
        relayUrl,
        machineId,
        machineName,
        source,
        domain,
        terminals,
        ...(peerRuntime === undefined ? {} : { peerRuntime }),
        ...(hostVersion === undefined ? {} : { hostVersion }),
        onStateChange: (state) => {
            process.stdout.write(`relay link: ${state}\n`);
            if (state === 'open') peerRuntime?.retryRecovery();
            if (state === 'replaced') {
                terminals.closeAll();
                process.exit(0);
            }
        },
    });

    // A dead host must never leave --takeover streams holding the desk's panes.
    const shutdown = (): void => {
        terminals.closeAll();
        peerRuntime?.close();
        void peerBroker?.close();
        void source.dispose();
        process.exit(0);
    };
    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);

    process.stdout.write(`host -> ${relayUrl}${useFake ? ' (fake)' : ' (herdr)'} [${mode}]\n`);
}

main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exit(error instanceof HostedAuthExpiredError ? 0 : 1);
});
