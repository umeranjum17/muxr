/**
 * A truncated selfhost.json (crashed write, full disk) used to kill bare
 * `muxr` and `muxr doctor` with a raw stack trace — the one command whose job
 * is diagnosing a broken install. Corrupt must also never look like "not
 * configured": reconfiguring would mint a new machine identity and destroy
 * every pairing. This flow also proves an unresponsive local relay port fails
 * promptly instead of leaving setup waiting forever.
 */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';

const scratch = mkdtempSync(join(tmpdir(), 'muxr-selfhost-state-'));
process.env.MUXR_HOME = scratch;
process.env.MUXR_NO_SERVICE_COMMANDS = '1';
const { ensureSelfhostRelay, inspectSetup, selfhostConfigured, selfhostStateUnreadable, startSelfHost } = await import('../../setup/index.mjs');

assert.equal(selfhostConfigured(), false);
assert.equal(selfhostStateUnreadable(), false);

writeFileSync(join(scratch, 'selfhost.json'), '{"version":1,"relayPort":');
assert.equal(selfhostConfigured(), false);
assert.equal(selfhostStateUnreadable(), true);
assert.equal(await startSelfHost(['--dry-run']), 1, 'self-host setup must refuse to reconfigure over corrupt state');
assert.equal(await inspectSetup(), 1, 'doctor must fail over corrupt selfhost state');

writeFileSync(join(scratch, 'selfhost.json'), '{"version":1,"relayPort":8792}\n');
assert.equal(selfhostConfigured(), true);
assert.equal(selfhostStateUnreadable(), false);

const sockets = new Set();
const blackhole = createServer((socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
});
await new Promise((resolve) => blackhole.listen(0, '127.0.0.1', resolve));
const started = Date.now();
try {
    await assert.rejects(ensureSelfhostRelay(blackhole.address().port), /accepts connections but did not answer/);
    assert.ok(Date.now() - started < 5_000, 'an unresponsive local port stalled setup');
    assert.equal(existsSync(join(scratch, 'relay', 'relay.pid')), false, 'stalled setup left a relay process behind');
} finally {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => blackhole.close(resolve));
}

// A headless operator configures while the port is occupied, then hands the
// private state to a foreground host. Configuration must never probe or spawn
// the relay, and repeat invocations must preserve bytes, mtimes and identity.
const configuredHome = join(scratch, 'headless');
mkdirSync(configuredHome, { mode: 0o700 });
const cli = fileURLToPath(new URL('../../cli.mjs', import.meta.url));
const environment = { ...process.env, HOME: configuredHome, MUXR_HOME: configuredHome };
delete environment.MUXR_RELAY_PORT;
const configure = (args) => execFileSync(process.execPath, [cli, 'self-host', '--configure-only', ...args], {
    env: environment, encoding: 'utf8', timeout: 5_000, stdio: ['ignore', 'pipe', 'pipe'],
});
const occupied = createServer((socket) => socket.destroy());
await new Promise((resolve) => occupied.listen(0, '127.0.0.1', resolve));
try {
    const port = occupied.address().port;
    const args = ['--advertise', `ws://cloud.example.ts.net:${port}`, '--port', String(port)];
    const output = configure(args);
    assert.match(output, /no relay or service started/);
    assert.match(output, /MUXR_MODE=selfhost muxr up/);
    assert.match(output, /muxr pair/);
    const path = join(configuredHome, 'selfhost.json');
    const mintPath = join(configuredHome, 'relay', 'mint-secret');
    const before = readFileSync(path, 'utf8');
    const state = JSON.parse(before);
    assert.equal(state.bindHost, '0.0.0.0');
    assert.equal(state.relayPort, port);
    assert.equal(state.relayUrl, `ws://cloud.example.ts.net:${port}`);
    assert.ok(state.machine.id && state.machine.crypto.signingSecretKey);
    assert.equal(state.mintSecret, JSON.parse(readFileSync(mintPath, 'utf8')));
    const stateStat = statSync(path);
    const mintStat = statSync(mintPath);
    assert.equal(stateStat.mode & 0o777, 0o600);
    assert.equal(mintStat.mode & 0o777, 0o600);
    configure(args);
    assert.equal(readFileSync(path, 'utf8'), before);
    assert.equal(statSync(path).mtimeMs, stateStat.mtimeMs);
    assert.equal(statSync(mintPath).mtimeMs, mintStat.mtimeMs);
    assert.equal(existsSync(join(configuredHome, 'logs')), false, 'configuration started a relay');
    assert.equal(existsSync(join(configuredHome, '.config', 'systemd')), false, 'configuration installed a service');
    assert.throws(() => configure([...args, '--tunnel']), /accepts only --advertise and --port/);
    assert.throws(() => configure(['--port', String(port)]), /requires --advertise/);
    assert.throws(() => configure(['--advertise', 'https://cloud.example.ts.net', '--port', String(port)]), /root ws:\/\/ or wss:\/\//);
    assert.throws(() => configure(['--advertise', `ws://other.example.ts.net:${port}`, '--port', String(port)]), /cannot replace an existing connection/);
    assert.equal(readFileSync(path, 'utf8'), before, 'refused commands modified pairing state');
} finally {
    await new Promise((resolve) => occupied.close(resolve));
    rmSync(scratch, { recursive: true, force: true });
}
process.stdout.write('selfhost state, stalled relay and headless configuration checks passed\n');
