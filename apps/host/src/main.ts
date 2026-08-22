import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, watchFile, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { createDeviceGrant } from '@muxr/crypto';
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

class HostedAuthExpiredError extends Error {}

interface HostedAuthState {
    version: 1;
    controlUrl: string;
    relayUrl: string;
    credential: string;
    credentialExpiresAt: string;
    machine: {
        id: string;
        crypto?: MachineCrypto;
    };
}

interface MachineCrypto {
    signingPublicKey: string;
    signingSecretKey: string;
    boxPublicKey: string;
    boxSecretKey: string;
    dataKey: string;
    keyVersion: number;
    devices: Array<{ deviceId: string; devicePublicKey: string; ingressKey: string; expiresAt: string; kind?: 'browser' }>;
    pendingRotation?: {
        keyVersion: number;
        dataKey: string;
        devices: Array<{ deviceId: string; devicePublicKey: string; ingressKey: string; expiresAt: string; kind?: 'browser' }>;
        grants: Array<{ device_public_key: string; grant: string }>;
    };
}

interface SelfhostState {
    version: 1;
    relayPort?: number;
    relayUrl?: string;
    mintSecret?: string;
    machineCredential?: string;
    credentialExpiresAt?: string;
    relayLocation?: 'local' | 'remote';
    machine: { id: string; crypto: MachineCrypto };
}

function selfhostFile(): string {
    return join(env('MUXR_HOME') ?? join(homedir(), '.muxr'), 'selfhost.json');
}

function readSelfhostAuth(): SelfhostState | undefined {
    const path = selfhostFile();
    if (!existsSync(path)) return undefined;
    const info = lstatSync(path);
    if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077) !== 0) {
        throw new Error(`${path} must be a regular owner-only file`);
    }
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<SelfhostState>;
    if (parsed.version !== 1 || typeof parsed.machine?.id !== 'string' || parsed.machine.crypto === undefined
        || typeof parsed.mintSecret !== 'string' && typeof parsed.machineCredential !== 'string'
        || parsed.relayLocation === 'remote' && typeof parsed.relayUrl !== 'string'
        || parsed.relayLocation !== 'remote' && typeof parsed.relayPort !== 'number') return undefined;
    if (parsed.credentialExpiresAt !== undefined && Date.parse(parsed.credentialExpiresAt) <= Date.now()) {
        throw new HostedAuthExpiredError('remote relay machine credential expired; create a fresh enrollment from the relay owner');
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
        throw new Error(`${path} must be a regular owner-only file`);
    }
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<HostedAuthState>;
    if (parsed.version !== 1 || typeof parsed.controlUrl !== 'string' || typeof parsed.relayUrl !== 'string' || typeof parsed.credential !== 'string'
        || typeof parsed.credentialExpiresAt !== 'string' || typeof parsed.machine?.id !== 'string') return undefined;
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
        const existing = localDevices.get(device.device_id);
        const expiresAt = existing?.kind === 'browser'
            ? Math.min(Date.parse(existing.expiresAt), Date.now() + 8 * 60 * 60_000)
            : DURABLE_GRANT_EXPIRES_AT;
        return {
            local: {
                deviceId: device.device_id,
                devicePublicKey: device.device_public_key,
                ingressKey,
                expiresAt: new Date(expiresAt).toISOString(),
                ...(existing?.kind === 'browser' ? { kind: 'browser' as const } : {}),
            },
            upload: {
                device_public_key: device.device_public_key,
                grant: JSON.stringify(createDeviceGrant({
                    machineId: auth.machine.id,
                    machineSigningSecretKey: crypto.signingSecretKey,
                    machineKey: { publicKey: crypto.boxPublicKey, secretKey: crypto.boxSecretKey },
                    deviceId: device.device_id,
                    devicePublicKey: device.device_public_key,
                    dataKey,
                    ingressKey,
                    keyVersion: nextVersion,
                    expiresAt,
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
        process.exit(error instanceof HostedAuthExpiredError ? 0 : 1);
    }
}
const { hostedAuth, selfhostAuth } = readAuthStates();
const relayUrl = env('MUXR_RELAY_URL') ?? hostedAuth?.relayUrl
    ?? (selfhostAuth?.relayLocation === 'remote' ? selfhostAuth.relayUrl : undefined)
    ?? (selfhostAuth?.relayPort === undefined ? undefined : `ws://127.0.0.1:${selfhostAuth.relayPort}/relay`)
    ?? 'ws://127.0.0.1:8792';
const machineId = env('MUXR_MACHINE_ID') ?? hostedAuth?.machine.id ?? selfhostAuth?.machine.id ?? hostname();
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
if (mode === 'hosted' && hostedAuth === undefined) throw new Error('hosted mode requires muxr setup/login state');
if (mode === 'selfhost' && selfhostAuth === undefined) throw new Error('selfhost mode requires `muxr self-host` state');
if (mode === 'hosted' && hostedAuth?.machine.crypto === undefined) throw new Error('hosted machine keys are missing; run `muxr setup` and re-pair devices');

async function main(): Promise<void> {
    if (mode === 'hosted') await reconcileHostedKeys(hostedAuth!);
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
            machineCrypto.devices.map((device) => [device.deviceId, device.kind === 'browser' ? 'browser' as const : 'native' as const]),
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
                    crypto.devices.map((device) => [device.deviceId, device.kind === 'browser' ? 'browser' as const : 'native' as const]),
                );
                keys.deviceExpiresAt = Object.fromEntries(
                    crypto.devices.map((device) => [device.deviceId, Date.parse(device.expiresAt)]),
                );
            } catch {
                // Keep serving with the last fully validated key set.
            }
        });
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
          });

    const hostVersion = resolveHostVersion();
    startHost({
        ...(hostedE2ee === undefined ? {} : { hostedE2ee }),
        ...(token === undefined ? {} : { token }),
        relayUrl,
        machineId,
        source,
        domain,
        terminals,
        ...(hostVersion === undefined ? {} : { hostVersion }),
        onStateChange: (state) => {
            process.stdout.write(`relay link: ${state}\n`);
            if (state === 'replaced') {
                terminals.closeAll();
                process.exit(0);
            }
        },
    });

    // A dead host must never leave --takeover streams holding the desk's panes.
    const shutdown = (): void => {
        terminals.closeAll();
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
