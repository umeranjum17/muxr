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
    // The kernel picks; the relay announces what it bound and the host is told
    // afterwards. A fixed port here is how a check ends up talking to someone
    // else's relay and passing without its own having ever started.
    MUXR_RELAY_PORT: '0',
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

const PORT = await waitForRelay(start('relay', ['apps/relay/dist/main.js'])).catch((error) => {
    process.stderr.write(`\nFAIL: ${error.message}\n`);
    shutdown();
    process.exit(1);
});
env.MUXR_RELAY_URL = `ws://127.0.0.1:${PORT}`;
start('host', ['apps/host/dist/main.js', '--fake']);
await delay(600);

const probe = spawn('node', ['apps/probe/dist/main.js'], { env, stdio: 'inherit' });
probe.on('exit', (code) => {
    shutdown();
    process.exit(code ?? 1);
});

process.on('SIGINT', () => { shutdown(); process.exit(130); });
