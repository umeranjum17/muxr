/** Run the user-operated host bridge. In self-host mode this process also owns the relay child. */
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const packagedHost = fileURLToPath(new URL('./host.js', import.meta.url));
const hostEntry = existsSync(packagedHost)
    ? packagedHost
    : fileURLToPath(new URL('../apps/host/dist/main.js', import.meta.url));
const packagedRelay = fileURLToPath(new URL('./relay.js', import.meta.url));
const relayEntry = existsSync(packagedRelay)
    ? packagedRelay
    : fileURLToPath(new URL('../apps/relay/dist/main.js', import.meta.url));
const children = [];
let stopping = false;

function start(entry, env = process.env, args = []) {
    const child = spawn(process.execPath, [entry, ...args], { stdio: 'inherit', env });
    children.push(child);
    child.on('exit', (code, signal) => {
        if (stopping) return;
        stopping = true;
        for (const sibling of children) if (sibling !== child && sibling.exitCode === null) sibling.kill('SIGTERM');
        process.stderr.write(`muxr ${entry === hostEntry ? 'host' : 'relay'} exited (${signal ?? code ?? 1})\n`);
        process.exitCode = code ?? 1;
    });
    return child;
}

async function waitForRelay(port) {
    for (let attempt = 0; attempt < 30; attempt += 1) {
        const ready = await fetch(`http://127.0.0.1:${port}/health`).then((response) => response.ok).catch(() => false);
        if (ready) return;
        await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new Error(`muxr relay did not become ready on :${port}`);
}

for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => stop(signal));
process.on('exit', () => {
    for (const child of children) if (child.exitCode === null) child.kill('SIGKILL');
});

const mode = process.env.MUXR_MODE;
if (mode === 'selfhost' || mode === 'relay') {
    const root = process.env.MUXR_HOME?.trim() || join(homedir(), '.muxr');
    const state = JSON.parse(readFileSync(join(root, 'selfhost.json'), 'utf8'));
    if (mode === 'relay' || state.relayLocation !== 'remote') {
        const port = Number(state.relayPort);
        if (!Number.isInteger(port)) throw new Error('self-host relay state has no valid port');
        const relay = start(relayEntry, {
            ...process.env,
            MUXR_RELAY_LOCAL_AUTHORITY: '1',
            MUXR_RELAY_MDNS: '1',
            MUXR_RELAY_PORT: String(port),
            MUXR_RELAY_HOST: state.bindHost || '0.0.0.0',
            MUXR_RELAY_DATA_DIR: join(root, 'relay'),
            ...(state.webRoot ? { MUXR_WEB_ROOT: state.webRoot } : {}),
            ...(state.webOrigin ? { MUXR_ALLOWED_ORIGINS: state.webOrigin } : {}),
        });
        try { await waitForRelay(port); }
        catch (cause) {
            stopping = true;
            relay.kill('SIGTERM');
            throw cause;
        }
    }
}

if (mode !== 'relay') start(hostEntry, process.env, process.argv.slice(3));

function stop(signal) {
    if (stopping) return;
    stopping = true;
    for (const child of children) if (child.exitCode === null) child.kill(signal);
    setTimeout(() => {
        for (const child of children) if (child.exitCode === null) child.kill('SIGKILL');
        process.exit(0);
    }, 2000).unref();
}
