/**
 * A private Herdr Core for a lab, beside (never instead of) anything else on this desk.
 *
 * The pinned release is downloaded once, its SHA-256 checked against both the pin below and
 * the release's own manifest, and cached outside the repo. Each lab core gets a 3-character
 * scratch dir under /tmp (Unix socket paths are short), a 2-character `HC_SESSION`, private
 * XDG runtime/state/config dirs and HOME, and an env built from an allowlist, so it can never
 * reach a person's own core, Herdr TUI, agent logins or SSH agent. A private XDG_RUNTIME_DIR
 * also keeps it out of the systemd user manager: the core is our foreground child, stopped
 * with `hc server stop` scoped to that session and then by its exact PID.
 *
 * Plan step 2 (data/muxr-herdr-core-design/report.md, section 8): the host cannot read Herdr
 * Core yet, so nothing here is wired into the host or the phone.
 */
import { createHash, randomInt } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { createConnection } from 'node:net';
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { spawnCommand as spawn, onCommandCleanup } from './commands.mjs';

/** The one Herdr Core release labs run. Bump version and digests together, from its manifest. */
export const HERDR_CORE_PIN = {
    version: '0.1.18',
    generation: 1,
    sha256: {
        'linux-x86_64': '5b2f97cb4b2a9d7a6b2cc5942628203ed9fbb7cc0c2b4b09ad8a6f5648e246b7',
        'linux-aarch64': 'cf33393cf950bb763734dc3e16610ab9daf8492391a4ef0de56026cd7f752853',
    },
};
const RELEASES = 'https://releases.herdr.dev/core';

function target() {
    const arch = { x64: 'x86_64', arm64: 'aarch64' }[process.arch];
    const name = `${process.platform}-${arch}`;
    if (!HERDR_CORE_PIN.sha256[name]) throw new Error(`the Herdr Core lab runs on Linux only for now (this is ${name})`);
    return name;
}

const sha256 = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');

/**
 * The pinned `herdr-core` binary, downloading it on first use.
 * `cacheDir` defaults to MUXR_LAB_HC_CACHE, else ~/.cache/muxr-lab/herdr-core.
 * Returns the binary and how its digest was checked, for a journey's record.
 */
export async function ensureHerdrCore({ cacheDir } = {}) {
    const { version } = HERDR_CORE_PIN;
    const name = target();
    const pinned = HERDR_CORE_PIN.sha256[name];
    const dir = join(cacheDir ?? process.env.MUXR_LAB_HC_CACHE ?? join(homedir(), '.cache', 'muxr-lab', 'herdr-core'), version);
    const tarball = join(dir, `herdr-core-${name}.tar.gz`);
    const binary = join(dir, 'herdr-core');
    // The release's own manifest must name the pinned digest. Checked on every use, so a cached
    // copy is held to it too; a desk that cannot reach the release site says so in the record.
    let manifestSha = 'unreachable';
    const manifest = await fetch(`${RELEASES}/${version}/manifest.json`).then((r) => (r.ok ? r.json() : null)).catch(() => null);
    if (manifest) {
        manifestSha = manifest.targets?.[name]?.sha256 ?? null;
        if (manifest.version !== version || manifestSha !== pinned) {
            throw new Error(`Herdr Core ${version} manifest does not match the pin (manifest ${manifest.version} ${manifestSha}, pinned ${pinned})`);
        }
    }
    if (!existsSync(tarball)) {
        if (!manifest) throw new Error(`cannot read the Herdr Core ${version} manifest from ${RELEASES}`);
        mkdirSync(dir, { recursive: true });
        const response = await fetch(`${RELEASES}/${version}/herdr-core-${name}.tar.gz`);
        if (!response.ok) throw new Error(`Herdr Core ${version} download: HTTP ${response.status}`);
        const partial = `${tarball}.part`;
        writeFileSync(partial, Buffer.from(await response.arrayBuffer()));
        const got = sha256(partial);
        if (got !== pinned) { rmSync(partial, { force: true }); throw new Error(`Herdr Core download digest ${got} is not the pinned ${pinned}`); }
        renameSync(partial, tarball);
        rmSync(binary, { force: true });
    }
    const fileSha = sha256(tarball);
    if (fileSha !== pinned) throw new Error(`cached ${tarball} digest ${fileSha} is not the pinned ${pinned}; delete it to download again`);
    if (!existsSync(binary)) execFileSync('tar', ['-xzf', tarball, '-C', dir, 'herdr-core'], { stdio: 'pipe' });
    const reported = execFileSync(binary, ['--version'], { encoding: 'utf8' }).trim();
    if (reported !== `hc ${version}`) throw new Error(`${binary} reports "${reported}", not hc ${version}`);
    return { binary, version, target: name, sha256: { pinned, file: fileSha, manifest: manifestSha } };
}

/** A fresh 3-character dir under /tmp, owner-only. Exclusive mkdir, so two labs never share one. */
function shortDir() {
    const letters = 'abcdefghijklmnopqrstuvwxyz0123456789';
    for (let attempt = 0; attempt < 200; attempt += 1) {
        const tag = `${letters[randomInt(26)]}${letters[randomInt(letters.length)]}`;
        const dir = `/tmp/k${tag}`;
        try { mkdirSync(dir, { mode: 0o700 }); } catch { continue; }
        chmodSync(dir, 0o700);
        return { dir, session: tag };
    }
    throw new Error('no free 3-character lab dir under /tmp');
}

/**
 * Start a private Herdr Core and wait until it answers as our own child.
 * @returns {Promise<{ dir: string, session: string, socket: string, pid: number, version: string,
 *   env: Record<string,string>, hc: (args: string[]) => any, connect: () => Promise<ReturnType<typeof coreClient>>,
 *   log: () => string, stop: () => Promise<{ stoppedBy: string }> }>}
 */
export async function startHerdrCore({ binary } = {}) {
    const bin = binary ?? (await ensureHerdrCore()).binary;
    const { dir, session } = shortDir();
    const dirs = { HOME: 'h', XDG_RUNTIME_DIR: 'r', XDG_STATE_HOME: 's', XDG_CONFIG_HOME: 'c', XDG_DATA_HOME: 'd', XDG_CACHE_HOME: 'x' };
    const env = { HC_SESSION: session, TERM: 'xterm-256color' };
    for (const key of ['PATH', 'LANG', 'LC_ALL']) if (process.env[key] !== undefined) env[key] = process.env[key];
    for (const [key, sub] of Object.entries(dirs)) {
        env[key] = join(dir, sub);
        mkdirSync(env[key], { mode: 0o700 });
    }
    const socket = join(env.XDG_RUNTIME_DIR, 'herdr-core', `${session}.sock`);
    const logPath = join(dir, 'core.log');
    const logFd = openSync(logPath, 'a');
    const child = spawn(bin, ['serve'], { env, cwd: env.HOME, stdio: ['ignore', logFd, logFd] });
    closeSync(logFd);
    let exited = null;
    const gone = new Promise((resolve) => child.once('exit', (code, signal) => { exited = { code, signal }; resolve(exited); }));
    const log = () => { try { return readFileSync(logPath, 'utf8'); } catch { return ''; } };
    // CLI verbs without a program argv only: `--json` goes last.
    const hc = (args) => {
        const out = spawnSync(bin, [...args, '--json'], { env, cwd: env.HOME, encoding: 'utf8', timeout: 30_000 });
        if (out.status !== 0) throw new Error(`hc ${args.join(' ')} failed (${out.status}): ${(out.stderr || out.stdout).trim()}`);
        return JSON.parse(out.stdout);
    };
    let stopped;
    const stop = () => stopped ??= (async () => {
        let stoppedBy = 'already exited';
        if (exited === null) {
            // Scoped by HC_SESSION and the private XDG dirs in env: this reaches our core only.
            spawnSync(bin, ['server', 'stop', '--json'], { env, cwd: env.HOME, stdio: 'ignore', timeout: 15_000 });
            stoppedBy = 'hc server stop';
            const timer = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
            if (await Promise.race([gone.then(() => true), timer(5_000).then(() => false)]) === false) {
                stoppedBy = 'SIGTERM to its own PID';
                try { process.kill(child.pid, 'SIGTERM'); } catch { /* exited meanwhile */ }
                if (await Promise.race([gone.then(() => true), timer(5_000).then(() => false)]) === false) {
                    stoppedBy = 'SIGKILL to its own PID';
                    try { process.kill(child.pid, 'SIGKILL'); } catch { /* exited meanwhile */ }
                    await gone;
                }
            }
        }
        rmSync(dir, { recursive: true, force: true });
        return { stoppedBy };
    })();
    onCommandCleanup(stop);
    try {
        let status;
        for (let attempt = 0; attempt < 100 && !status; attempt += 1) {
            if (exited) throw new Error(`the lab Herdr Core exited (${JSON.stringify(exited)}): ${log().trim().slice(-400)}`);
            if (existsSync(socket) && statSync(socket).isSocket()) {
                try { status = hc(['server', 'status']); } catch { /* still starting */ }
            }
            if (!status) await new Promise((resolve) => setTimeout(resolve, 100));
        }
        if (!status) throw new Error(`the lab Herdr Core never answered: ${log().trim().slice(-400)}`);
        // The core that answers must be the child we started, or the socket is someone else's.
        if (status.pid !== child.pid) throw new Error(`the core on ${socket} is pid ${status.pid}, not our child ${child.pid}`);
        return { dir, session, socket, pid: child.pid, version: status.version, env, hc, log, stop, connect: () => coreClient(socket) };
    } catch (cause) {
        await stop();
        throw cause;
    }
}

/** Frame kinds of Herdr Core's framed mode (schema/README.md). */
export const FRAME = { DATA: 0, CREDIT: 1, CLOSE: 2, RESIZE: 3 };

/**
 * One API connection, as the host will hold it: JSON-RPC lines, then framed mode after
 * `hello {framed: true}`. Notifications collect in `events`; stream bytes per channel.
 */
export async function coreClient(socket) {
    const conn = createConnection(socket);
    await new Promise((resolve, reject) => { conn.once('connect', resolve); conn.once('error', reject); });
    let buffer = Buffer.alloc(0);
    let framed = false;
    let switchId = null;
    let nextId = 0;
    const pending = new Map();
    const events = [];
    const streams = new Map();
    const closes = new Map();
    const frame = (channel, kind, payload) => {
        const head = Buffer.alloc(9);
        head.writeUInt32LE(channel, 0);
        head.writeUInt8(kind, 4);
        head.writeUInt32LE(payload.length, 5);
        return Buffer.concat([head, payload]);
    };
    const onMessage = (message) => {
        const waiter = message.id !== undefined ? pending.get(message.id) : undefined;
        if (waiter) { pending.delete(message.id); waiter(message); } else events.push(message);
    };
    conn.on('data', (chunk) => {
        buffer = Buffer.concat([buffer, chunk]);
        while (!framed) {
            const end = buffer.indexOf(10);
            if (end < 0) return;
            const line = buffer.subarray(0, end).toString();
            buffer = buffer.subarray(end + 1);
            const message = JSON.parse(line);
            // The hello reply is the last plain line; everything after it is framed.
            if (message.id !== undefined && message.id === switchId) framed = true;
            onMessage(message);
        }
        while (buffer.length >= 9) {
            const channel = buffer.readUInt32LE(0);
            const kind = buffer.readUInt8(4);
            const length = buffer.readUInt32LE(5);
            if (buffer.length < 9 + length) return;
            const payload = buffer.subarray(9, 9 + length);
            buffer = buffer.subarray(9 + length);
            if (channel === 0 && kind === FRAME.DATA) onMessage(JSON.parse(payload.toString()));
            else if (kind === FRAME.DATA) {
                (streams.get(channel) ?? streams.set(channel, []).get(channel)).push(payload);
                conn.write(frame(channel, FRAME.CREDIT, Buffer.from(Uint32Array.of(payload.length).buffer)));
            } else if (kind === FRAME.CLOSE) closes.set(channel, payload.toString());
        }
    });
    const call = (method, params = {}, timeoutMs = 30_000) => new Promise((resolve, reject) => {
        const id = ++nextId;
        const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method} timed out`)); }, timeoutMs);
        pending.set(id, (message) => {
            clearTimeout(timer);
            if (message.error) reject(Object.assign(new Error(`${method}: ${message.error.message}`), { kind: message.error.data?.kind }));
            else resolve(message.result);
        });
        const text = JSON.stringify({ jsonrpc: '2.0', id, method, params });
        conn.write(framed ? frame(0, FRAME.DATA, Buffer.from(text)) : `${text}\n`);
    });
    return {
        events,
        call,
        /** Switch to framed mode; returns the hello reply (features, generation). */
        hello: (params = {}) => {
            switchId = nextId + 1;
            return call('hello', { ...params, framed: true });
        },
        type: (channel, text) => conn.write(frame(channel, FRAME.DATA, Buffer.from(text))),
        detach: (channel) => conn.write(frame(channel, FRAME.CLOSE, Buffer.alloc(0))),
        screen: (channel) => Buffer.concat(streams.get(channel) ?? []).toString(),
        closed: (channel) => closes.get(channel),
        close: () => conn.destroy(),
    };
}
