import { createHash, randomBytes } from 'node:crypto';
import nacl from 'tweetnacl';
import QRCode from 'qrcode';
import { spawnSync } from 'node:child_process';
import {
    chmodSync,
    existsSync,
    mkdirSync,
    readFileSync,
    renameSync,
    rmSync,
    statSync,
    writeFileSync,
} from 'node:fs';
import { homedir, hostname, networkInterfaces, platform as hostPlatform } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

export const MIN_HERDR = [0, 8, 0];
export const DURABLE_GRANT_EXPIRES_AT = Date.UTC(9999, 11, 31, 23, 59, 59, 999);
export const BROWSER_GRANT_TTL_MS = 8 * 60 * 60_000;
export const HERDR_INSTALL_URL = 'https://herdr.dev/install.sh';
export const HERDR_INSTALL_HINT = 'run `muxr setup` to install Herdr automatically';
// Lifecycle integrations are discovered dynamically from `herdr integration status`.
// Agent prompt files are never installed or rewritten.
export const INTEGRATION_COMMANDS = {
    'antigravity-cli': ['antigravity', 'antigravity-cli'],
    qodercli: ['qoder', 'qodercli'],
    mastracode: ['mastra', 'mastracode'],
};

export const print = (text = '') => process.stdout.write(`${text}\n`);
export const error = (text) => process.stderr.write(`${text}\n`);
export async function printTerminalQr(value) {
    if (!process.stdout.isTTY || process.env.TERM === 'dumb' || process.env.NO_COLOR !== undefined
        || process.env.MUXR_NO_TUI === '1' || process.env.SSH_CONNECTION) {
        print('QR omitted in append-only/plain output; use the exact pairing string below.');
        return;
    }
    const qr = await QRCode.toString(value, { type: 'utf8', margin: 4, errorCorrectionLevel: 'M' });
    const lines = qr.split('\n');
    const width = Math.max(...lines.map((line) => [...line].length));
    const tooWide = process.stdout.columns !== undefined && width > process.stdout.columns;
    // Pairing prints the exact string, save location, and waiting state after
    // the QR. Keep those rows plus the complete quiet zone visible together.
    const tooTall = process.stdout.rows !== undefined && lines.length + 5 > process.stdout.rows;
    if (tooWide || tooTall) {
        print(`QR omitted because this terminal is ${process.stdout.columns ?? 'too few'} columns × ${process.stdout.rows ?? 'too few'} rows; use the exact pairing string below.`);
        return;
    }
    print(qr.split('\n').map((line) => `\x1b[47m\x1b[30m${line}\x1b[0m`).join('\n'));
}
export function env(name) {
    return process.env[name]?.trim() || undefined;
}

export const home = () => process.env.HOME?.trim() || homedir();
export const defaultStateDir = () => join(home(), '.muxr');
export const stateDir = () => env('MUXR_HOME') || defaultStateDir();
export const manifestPath = () => join(stateDir(), 'setup-manifest.json');
export const authPath = () => join(stateDir(), 'auth.json');

export const platform = () => env('MUXR_PLATFORM') || hostPlatform();
export const hash = (text) => createHash('sha256').update(text).digest('hex');
export const timestamp = () => new Date().toISOString().replaceAll(/[:.]/g, '-');
export const base64 = (bytes) => Buffer.from(bytes).toString('base64');
const cryptoEntry = existsSync(fileURLToPath(new URL('./crypto.js', import.meta.url)))
    ? new URL('./crypto.js', import.meta.url)
    : new URL('../packages/crypto/dist/index.js', import.meta.url);
export const {
    PAIRING_CODE_ALPHABET,
    createDeviceGrant,
    deriveV2Key,
    formatPairingCode,
    newV2ReplayTracker,
    openV2,
    pairingCodeHash,
    sealPairingCodePayload,
} = await import(cryptoEntry.href);

export function newPairingCode() {
    let code = '';
    const ceiling = Math.floor(256 / PAIRING_CODE_ALPHABET.length) * PAIRING_CODE_ALPHABET.length;
    while (code.length < 10) {
        for (const value of randomBytes(16)) {
            if (value < ceiling) code += PAIRING_CODE_ALPHABET[value % PAIRING_CODE_ALPHABET.length];
            if (code.length === 10) break;
        }
    }
    return formatPairingCode(code);
}

export function ensurePrivateDir(path) {
    mkdirSync(path, { recursive: true, mode: 0o700 });
    chmodSync(path, 0o700);
}

export function atomicWrite(path, text, mode = 0o600) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const temporary = `${path}.tmp-${process.pid}-${randomBytes(8).toString('hex')}`;
    try {
        writeFileSync(temporary, text, { mode, flag: 'wx' });
        chmodSync(temporary, mode);
        renameSync(temporary, path);
    } finally {
        rmSync(temporary, { force: true });
    }
}

export function loadManifest() {
    try {
        const parsed = JSON.parse(readFileSync(manifestPath(), 'utf8'));
        if (parsed.version === 1 && parsed.entries && parsed.herdrInstalled) return parsed;
    } catch {}
    return { version: 1, entries: {}, herdrInstalled: [] };
}

export function saveManifest(manifest, dryRun) {
    if (dryRun) return;
    ensurePrivateDir(stateDir());
    atomicWrite(manifestPath(), `${JSON.stringify(manifest, null, 2)}\n`);
}

export function backup(path) {
    const destination = `${path}.muxr-backup-${timestamp()}`;
    writeFileSync(destination, readFileSync(path), { mode: statSync(path).mode & 0o777 });
    return destination;
}

export function realpathOrUndefined(path) {
    try { return realpathSync(path); } catch { return undefined; }
}

export function executable(command) {
    if (command.includes('/')) return existsSync(command) ? command : undefined;
    for (const directory of (process.env.PATH ?? '').split(delimiter)) {
        if (!directory) continue;
        const candidate = join(directory, command);
        try {
            if (statSync(candidate).isFile() && (statSync(candidate).mode & 0o111) !== 0) return candidate;
        } catch {}
    }
    return undefined;
}

export function run(command, args, options = {}) {
    const result = spawnSync(command, args, { encoding: 'utf8', ...options });
    return {
        ok: result.status === 0,
        status: result.status ?? 1,
        stdout: result.stdout?.trim() ?? '',
        stderr: result.stderr?.trim() ?? '',
        errorCode: result.error?.code,
    };
}

export function writeOwned(path, content, manifest, { dryRun, force, mode = 0o600 }) {
    const current = existsSync(path) ? readFileSync(path, 'utf8') : undefined;
    const entry = manifest.entries[path];
    if (entry && entry.kind !== 'owned') throw new Error(`manifest kind mismatch for ${path}`);
    if (entry && (current === undefined || hash(current) !== entry.hash) && !force) {
        throw new Error(`drift: ${path} was edited or removed; rerun with --force to replace it`);
    }
    if (current === content) {
        if (!entry && !dryRun) manifest.entries[path] = { kind: 'owned', hash: hash(content) };
        return false;
    }
    print(`  ${dryRun ? 'would write' : 'write'} ${path}`);
    if (dryRun) return true;
    let backupPath = entry?.backup;
    if (current !== undefined && backupPath === undefined) backupPath = backup(path);
    atomicWrite(path, content, mode);
    manifest.entries[path] = { kind: 'owned', hash: hash(content), ...(backupPath ? { backup: backupPath } : {}) };
    return true;
}

export function removeManaged(path, entry, manifest, { dryRun, force }) {
    if (entry.kind !== 'owned') throw new Error(`manifest kind mismatch for ${path}`);
    if (!existsSync(path)) {
        delete manifest.entries[path];
        return false;
    }
    const current = readFileSync(path, 'utf8');
    if (hash(current) !== entry.hash && !force) throw new Error(`drift: ${path} was edited; refusing managed uninstall`);
    print(`  ${dryRun ? 'would remove' : 'remove'} ${path}`);
    if (!dryRun) {
        rmSync(path);
        delete manifest.entries[path];
    }
    return true;
}

export async function askVisible(question) {
    if (!process.stdin.isTTY || !process.stdout.isTTY) return false;
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    return new Promise((resolve) => rl.question(question, (answer) => {
        rl.close();
        resolve(/^y(?:es)?$/i.test(answer.trim()));
    }));
}

export function xml(text) {
    return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
}

export function systemdArg(text) {
    return `"${text.replaceAll('%', '%%').replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
}

export function publicRelayUrl(value) {
    if (typeof value !== 'string') return undefined;
    try {
        const parsed = new URL(value);
        if (!['ws:', 'wss:'].includes(parsed.protocol) || parsed.username !== '' || parsed.password !== '') return undefined;
        return parsed.origin;
    } catch { return undefined; }
}

export function validMachineCrypto(value, expected) {
    if (typeof value !== 'object' || value === null) return false;
    const validBase64 = (text, bytes) => {
        if (typeof text !== 'string' || text.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(text)) return false;
        try { return Buffer.from(text, 'base64').length === bytes; } catch { return false; }
    };
    const keys = validBase64(value.signingPublicKey, 32)
        && validBase64(value.signingSecretKey, 64)
        && validBase64(value.boxPublicKey, 32)
        && validBase64(value.boxSecretKey, 32)
        && validBase64(value.dataKey, 32);
    const parseGrant = (text) => {
        if (typeof text !== 'string' || text.length === 0) return undefined;
        try {
            const grant = JSON.parse(text);
            return grant.v === 1
                && validBase64(grant.sender, 32)
                && validBase64(grant.signer, 32)
                && validBase64(grant.sig, 64)
                && typeof grant.box === 'string'
                && /^[A-Za-z0-9+/]+={0,2}$/.test(grant.box)
                && Buffer.from(grant.box, 'base64').length > 40
                ? grant : undefined;
        } catch { return undefined; }
    };
    const validCapabilities = (capabilities) => Array.isArray(capabilities) && capabilities.length > 0 && capabilities.length <= 6
        && new Set(capabilities).size === capabilities.length
        && capabilities.every((capability) => ['list', 'read', 'status', 'watch', 'prompt', 'start'].includes(capability));
    const validDevice = (device) => {
        if (typeof device !== 'object' || device === null) return false;
        const peer = device.kind === 'peer';
        return typeof device.deviceId === 'string' && device.deviceId.length > 0
            && validBase64(device.devicePublicKey, 32)
            && validBase64(device.ingressKey, 32)
            && typeof device.expiresAt === 'string' && Number.isFinite(Date.parse(device.expiresAt))
            && (device.kind === undefined || device.kind === 'browser' || peer)
            && (peer ? device.authority === undefined && validBase64(device.dataKey, 32) && validCapabilities(device.capabilities)
                : device.dataKey === undefined && device.capabilities === undefined && device.allowedCwds === undefined
                    && (device.authority === undefined || device.authority === 'control' || device.authority === 'observe'))
            && (!peer || (device.capabilities.includes('start')
                ? Array.isArray(device.allowedCwds) && device.allowedCwds.length > 0
                    && device.allowedCwds.every((cwd) => typeof cwd === 'string' && cwd !== '')
                : device.allowedCwds === undefined));
    };
    if (!keys || !Number.isInteger(value.keyVersion) || value.keyVersion < 1
        || !Array.isArray(value.devices) || !value.devices.every(validDevice)
        || new Set(value.devices.map((device) => device.deviceId)).size !== value.devices.length) return false;
    const pending = value.pendingRotation;
    if (pending === undefined) return true;
    if (!validBase64(pending.dataKey, 32) || !Array.isArray(pending.devices) || !pending.devices.every(validDevice)
        || new Set(pending.devices.map((device) => device.deviceId)).size !== pending.devices.length
        || !Array.isArray(pending.grants) || pending.grants.length !== pending.devices.length) return false;
    const kind = pending.kind;
    const peer = kind === 'peer-revoke-v1';
    const selfhost = kind === 'selfhost-revoke-v1';
    if (kind !== undefined && !peer && !selfhost) return false;
    if (kind === undefined && expected !== 'hosted') return false;
    if (selfhost && expected !== 'selfhost') return false;
    if (peer && pending.authorityKind !== expected) return false;
    const version = pending.keyVersion;
    if (kind === undefined ? !Number.isInteger(version) || version !== value.keyVersion + 1
        : !Number.isInteger(pending.previousKeyVersion) || !Number.isInteger(version)
            || version !== pending.previousKeyVersion + 1
            || value.keyVersion !== pending.previousKeyVersion && value.keyVersion !== version
            || typeof pending.revokedDeviceId !== 'string' || typeof pending.revokedDeviceName !== 'string') return false;
    const byId = new Map(pending.devices.map((device) => [device.deviceId, device]));
    const expectedKeys = new Set(pending.devices.map((device) => device.devicePublicKey));
    const seen = new Set();
    return pending.grants.every((entry) => {
        if (typeof entry !== 'object' || entry === null) return false;
        const deviceKey = kind === undefined ? entry.device_public_key : byId.get(entry.deviceId)?.devicePublicKey ?? entry.devicePublicKey;
        const grant = parseGrant(entry.grant);
        if (typeof deviceKey !== 'string' || !expectedKeys.has(deviceKey) || seen.has(deviceKey) || grant === undefined
            || grant.sender !== value.boxPublicKey || grant.signer !== value.signingPublicKey) return false;
        seen.add(deviceKey);
        return true;
    }) && seen.size === expectedKeys.size;
}

export function machineIdentity(existing) {
    if (existing?.machine?.crypto?.signingPublicKey && existing?.machine?.crypto?.signingSecretKey
        && existing?.machine?.crypto?.boxPublicKey && existing?.machine?.crypto?.boxSecretKey
        && existing?.machine?.crypto?.dataKey && existing?.machine?.id) return existing.machine;
    const signing = nacl.sign.keyPair();
    const box = nacl.box.keyPair();
    const publicKey = base64(signing.publicKey);
    return {
        id: `machine-${hash(publicKey).slice(0, 16)}`,
        name: hostname(),
        publicKey,
        crypto: {
            signingPublicKey: publicKey,
            signingSecretKey: base64(signing.secretKey),
            boxPublicKey: base64(box.publicKey),
            boxSecretKey: base64(box.secretKey),
            dataKey: base64(nacl.randomBytes(32)),
            keyVersion: 1,
            devices: [],
        },
    };
}

export async function api(base, path, options = {}) {
    const response = await fetch(`${base.replace(/\/+$/, '')}${path}`, {
        ...options,
        headers: { 'content-type': 'application/json', ...options.headers },
        signal: AbortSignal.timeout(15_000),
    });
    const body = await response.json().catch(() => ({}));
    return { response, body };
}

export function lanAddress() {
    for (const list of Object.values(networkInterfaces())) {
        for (const info of list ?? []) {
            if (info.family === 'IPv4' && !info.internal) return info.address;
        }
    }
    return undefined;
}

export function flagValue(args, name) {
    const inline = args.find((a) => a.startsWith(`${name}=`));
    if (inline !== undefined) return inline.slice(name.length + 1);
    const index = args.indexOf(name);
    return index >= 0 ? args[index + 1] : undefined;
}

export { nacl, hostPlatform, createHash, randomBytes };
