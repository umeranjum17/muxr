import { createHash, randomBytes } from 'node:crypto';
import { boxKeyPair, signingKeyPairFromSeed } from '@byokit/seal';
import { qrText } from '@byokit/ui-core/link';
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
import {
    BROWSER_GRANT_TTL_MS,
    DURABLE_GRANT_EXPIRES_AT,
    publicRelayUrl,
    validMachineCrypto,
} from '../domain/dist/index.js';

export const MIN_HERDR = [0, 9, 1];
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
/** Whether this terminal takes the in-place, full-screen-capable offer view (not plain or dumb output). */
export function richTerminal() {
    return process.stdout.isTTY && process.env.TERM !== 'dumb' && process.env.NO_COLOR === undefined && process.env.MUXR_NO_TUI !== '1';
}
// Half-block text rows from the kit (quiet border of 4). The kit trims trailing
// spaces, so printTerminalQr pads back to the full matrix width: a ragged right
// edge would eat the quiet zone the phone's scanner needs.
function qrLines(value) {
    return qrText(value, { border: 4 }).split('\n');
}
/** Terminal width and height; a zero or missing size means the terminal did not report one, so nothing is limited by it. */
export const terminalColumns = () => (process.stdout.columns > 0 ? process.stdout.columns : Infinity);
export const terminalRows = () => (process.stdout.rows > 0 ? process.stdout.rows : Infinity);
export function qrRows(value) {
    return qrLines(value).length;
}
/** Whether the QR fits whole, with `otherRows` terminal rows kept for text printed beside it (above it, or the cursor row its newline leaves below). */
export function qrFits(value, otherRows = 0) {
    if (!richTerminal()) return false;
    const lines = qrLines(value);
    const width = lines.length * 2 - 1;
    return width <= terminalColumns() && otherRows + lines.length <= terminalRows();
}
/** The QR as centered half-block rows, without a trailing newline. */
export function terminalQrText(value) {
    const lines = qrLines(value);
    // QR sides are always odd, and each text row covers two module rows, so
    // the side is lines*2-1; padding is a no-op if the kit ever stops trimming.
    const width = lines.length * 2 - 1;
    // Centered in the terminal: a scannable code reads as the primary content
    // of the screen, not a left-edge decoration.
    const columns = terminalColumns();
    const indent = Number.isFinite(columns) ? Math.max(0, Math.floor((columns - width) / 2)) : 0;
    return lines.map((line) => `${' '.repeat(indent)}\x1b[47m\x1b[30m${line.padEnd(width)}\x1b[0m`).join('\n');
}
export async function printTerminalQr(value) {
    if (!richTerminal()) {
        print('QR omitted in append-only/plain output; use the exact pairing string above.');
        return;
    }
    if (!qrFits(value, 1)) {
        print(`QR omitted because this terminal is ${process.stdout.columns ?? 'too few'} columns × ${process.stdout.rows ?? 'too few'} rows; use the exact pairing string above.`);
        return;
    }
    print(terminalQrText(value));
}
export function env(name) {
    return process.env[name]?.trim() || undefined;
}

export const home = () => process.env.HOME?.trim() || homedir();
export const defaultStateDir = () => join(home(), '.muxr');
export const stateDir = () => env('MUXR_HOME') || defaultStateDir();
export const manifestPath = () => join(stateDir(), 'setup-manifest.json');

export const platform = () => env('MUXR_PLATFORM') || hostPlatform();
export const hash = (text) => createHash('sha256').update(text).digest('hex');
export const timestamp = () => new Date().toISOString().replaceAll(/[:.]/g, '-');
export const base64 = (bytes) => Buffer.from(bytes).toString('base64');
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
        ok: result.status === 0 && result.error === undefined,
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

export async function askVisible(question, { piped = false, reaskOnEmpty = false } = {}) {
    if (process.stdin.isTTY && process.stdout.isTTY) {
        const rl = createInterface({ input: process.stdin, output: process.stdout });
        try {
            for (;;) {
                const answer = await new Promise((resolve) => {
                    const onClose = () => resolve(null);
                    rl.once('close', onClose);
                    rl.question(question, (line) => { rl.removeListener('close', onClose); resolve(line); });
                });
                // A closed input (Ctrl-D) declines instead of re-asking forever.
                if (answer === null || answer === undefined) return false;
                if (answer.trim() !== '' || !reaskOnEmpty) return /^y(?:es)?$/i.test(answer.trim());
            }
        } finally {
            rl.close();
        }
    }
    if (!piped) return false;
    if (process.stdin.isTTY) return false;
    print(question);
    return new Promise((resolve) => {
        const rl = createInterface({ input: process.stdin });
        let settled = false;
        const done = (value) => { if (!settled) { settled = true; rl.close(); resolve(value); } };
        rl.once('line', (answer) => done(/^y(?:es)?$/i.test(answer.trim())));
        rl.once('close', () => done(false));
    });
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
    const signing = signingKeyPairFromSeed(randomBytes(32));
    const box = boxKeyPair(randomBytes);
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
            dataKey: base64(randomBytes(32)),
            keyVersion: 1,
            devices: [],
        },
    };
}

export async function api(base, path, options = {}) {
    const { headers, signal = AbortSignal.timeout(15_000), ...request } = options;
    const response = await fetch(`${base.replace(/\/+$/, '')}${path}`, {
        ...request,
        headers: { 'content-type': 'application/json', ...headers },
        signal,
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

export function relayPortFromEnv() {
    const raw = process.env.MUXR_RELAY_PORT;
    if (raw === undefined || raw.trim() === '') return undefined;
    const parsed = Number(raw.trim());
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) throw new Error(`MUXR_RELAY_PORT ${JSON.stringify(raw.trim())} is not a valid TCP port (1-65535); unset it or set a port from 1 to 65535`);
    return parsed;
}

export { hostPlatform, createHash, randomBytes };
