/**
 * Boots relay + host, runs the probe, tears everything down.
 * Exit code is the probe's: 0 means the full contract crossed the wire.
 */
import { waitForRelay } from './waitForRelay.mjs';
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

// Not 8792: that is the real default, so a live relay would collide with this check.
const PORT = process.env.MUXR_RELAY_PORT ?? '8795';
// Isolate HOME + data dirs so the realtime.token handler takes its deterministic
// no-key path (no ~/.muxr/openai.key, no OPENAI_API_KEY => no OpenAI call),
// and the fake host/relay never touch the live ~/.muxr state.
const isolate = mkdtempSync(join(tmpdir(), 'muxr-skeleton-'));
const { OPENAI_API_KEY: _omitOpenAiKey, ...restEnv } = process.env;
const env = {
    ...restEnv,
    HOME: isolate,
    MUXR_DATA_DIR: join(isolate, 'host'),
    MUXR_RELAY_DATA_DIR: join(isolate, 'relay'),
    MUXR_RELAY_DEVELOPMENT_API: '1',
    MUXR_RELAY_PORT: PORT,
    MUXR_RELAY_URL: `ws://127.0.0.1:${PORT}`,
    MUXR_MACHINE_ID: 'skeleton',
};
const children = [];

function start(name, args) {
    const child = spawn('node', args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', (d) => process.stdout.write(`[${name}] ${d}`));
    child.stderr.on('data', (d) => process.stderr.write(`[${name}] ${d}`));
    children.push(child);
    return child;
}

function shutdown() {
    for (const child of children) child.kill('SIGTERM');
}

start('relay', ['apps/relay/dist/main.js']);
await waitForRelay(PORT);
start('host', ['apps/host/dist/main.js', '--fake']);
await delay(600);

const probe = spawn('node', ['apps/probe/dist/main.js'], { env, stdio: 'inherit' });
probe.on('exit', (code) => {
    shutdown();
    process.exit(code ?? 1);
});

process.on('SIGINT', () => { shutdown(); process.exit(130); });
