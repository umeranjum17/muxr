import { createHash, randomBytes } from 'node:crypto';
import nacl from 'tweetnacl';
import QRCode from 'qrcode';
import { spawnSync } from 'node:child_process';
import {
    chmodSync,
    existsSync,
    mkdirSync,
    readFileSync,
    realpathSync,
    renameSync,
    rmSync,
    statSync,
    writeFileSync,
} from 'node:fs';
import { homedir, hostname, networkInterfaces, platform as hostPlatform } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { cryptoModuleUrl } from './paths.mjs';
import {
    BROWSER_GRANT_TTL_MS,
    DURABLE_GRANT_EXPIRES_AT,
    publicRelayUrl,
    validMachineCrypto,
} from '../domain/dist/index.js';

export const MIN_HERDR = [0, 8, 0];
export { BROWSER_GRANT_TTL_MS, DURABLE_GRANT_EXPIRES_AT, publicRelayUrl, validMachineCrypto };
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
export const {
    PAIRING_CODE_ALPHABET,
    createDeviceGrant,
    deriveV2Key,
    formatPairingCode,
    newV2ReplayTracker,
    openV2,
    pairingCodeHash,
    sealPairingCodePayload,
} = await import(cryptoModuleUrl());

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
    const timeout = options.timeout ?? 30_000;
    const result = spawnSync(command, args, { encoding: 'utf8', ...options, timeout });
    return {
        ok: result.status === 0,
        status: result.status ?? 1,
        stdout: result.stdout?.trim() ?? '',
        stderr: result.stderr?.trim() || (result.error?.code === 'ETIMEDOUT'
            ? `${command} timed out after ${timeout / 1000} seconds`
            : result.error?.message ?? ''),
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
