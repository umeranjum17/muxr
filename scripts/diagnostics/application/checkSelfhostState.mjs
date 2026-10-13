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
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { createServer as createHttpServer } from 'node:http';

const scratch = mkdtempSync(join(tmpdir(), 'muxr-selfhost-state-'));
process.env.MUXR_HOME = scratch;
process.env.MUXR_NO_SERVICE_COMMANDS = '1';
const { ensureSelfhostRelay, inspectSetup, selfhostConfigured, selfhostStateUnreadable, selfhostControlBase, startSelfHost, stopOwnedSelfhostRelay } = await import('../../setup/index.mjs');

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
    const args = ['--advertise', `ws://100.127.255.254:${port}`, '--port', String(port)];
    const output = configure(args);
    assert.match(output, /no relay or service started/);
    assert.match(output, /MUXR_MODE=selfhost muxr up/);
    assert.match(output, /muxr pair/);
    const path = join(configuredHome, 'selfhost.json');
    const mintPath = join(configuredHome, 'relay', 'mint-secret');
    const before = readFileSync(path, 'utf8');
    const state = JSON.parse(before);
    assert.equal(state.bindHost, '100.127.255.254');
    assert.equal(state.connectionMode, 'private');
    assert.equal(state.relayPort, port);
    assert.equal(state.relayUrl, `ws://100.127.255.254:${port}`);
    assert.ok(state.machine.id && state.machine.crypto.signingSecretKey);
    assert.equal(state.mintSecret === JSON.parse(readFileSync(mintPath, 'utf8')), true, 'authority mismatch');
    assert.equal(selfhostControlBase(state), `http://100.127.255.254:${port}`);
    const stateStat = statSync(path);
    const mintStat = statSync(mintPath);
    assert.equal(stateStat.mode & 0o777, 0o600);
    assert.equal(mintStat.mode & 0o777, 0o600);
    configure(args);
    assert.equal(readFileSync(path, 'utf8') === before, true, 'configuration bytes changed');
    assert.equal(statSync(path).mtimeMs, stateStat.mtimeMs);
    assert.equal(statSync(mintPath).mtimeMs, mintStat.mtimeMs);
    assert.equal(existsSync(join(configuredHome, 'logs')), false, 'configuration started a relay');
    assert.equal(existsSync(join(configuredHome, '.config', 'systemd')), false, 'configuration installed a service');
    assert.throws(() => configure(['--port', String(port)]), /requires --advertise/);
    assert.throws(() => configure(['--advertise', 'https://cloud.example.ts.net', '--port', String(port)]), /root ws:\/\/ or wss:\/\//);
    assert.throws(() => configure(['--advertise', `ws://100.127.255.253:${port}`, '--port', String(port)]), /cannot replace an existing connection/);
    assert.throws(() => configure(['--advertise', `ws://192.0.2.1:${port}`, '--port', String(port)]), /Tailscale IPv4 address/);
    assert.throws(() => execFileSync(process.execPath, [cli, 'self-host', '--tunnel'], { env: environment, encoding: 'utf8', timeout: 5_000, stdio: ['ignore', 'pipe', 'pipe'] }), /set up for Tailscale only/);
    assert.equal(readFileSync(path, 'utf8') === before, true, 'refused commands modified pairing state');

    // The foreground unit stays alive with no relay while its persisted
    // tailnet address is absent; stopping it must not leave a child behind.
    const up = spawn(process.execPath, [cli, 'up'], { env: { ...environment, MUXR_MODE: 'relay' }, stdio: ['ignore', 'pipe', 'pipe'] });
    const closed = once(up, 'exit');
    let diagnostic = '';
    up.stderr.setEncoding('utf8').on('data', (chunk) => { diagnostic += chunk; });
    try {
        for (let attempt = 0; attempt < 40 && !diagnostic.includes('waiting for Tailscale address'); attempt += 1) {
            assert.equal(up.exitCode, null, diagnostic);
            await new Promise((resolve) => setTimeout(resolve, 100));
        }
        assert.match(diagnostic, /waiting for Tailscale address 100\.127\.255\.254/);
        await new Promise((resolve) => setTimeout(resolve, 1200));
        assert.equal(up.exitCode, null, 'address absence exited the foreground unit');
        assert.equal(diagnostic.match(/waiting for Tailscale address/g)?.length, 1, 'wait flooded the log');
        assert.equal(existsSync(join(configuredHome, 'relay', 'relay.pid')), false, 'wait started a relay before its address existed');
    } finally {
        up.kill('SIGTERM');
        let forced = false;
        const forceStop = setTimeout(() => { forced = true; up.kill('SIGKILL'); }, 10000);
        try { await closed; }
        finally { clearTimeout(forceStop); }
        assert.equal(forced, false, 'waiting foreground process ignored stop');
    }

    // Configure-only serves plain ws:// on the tailnet; a wss:// advertise has no TLS behind it.
    const secureHome = join(scratch, 'secure-headless');
    mkdirSync(secureHome, { mode: 0o700 });
    assert.throws(() => execFileSync(process.execPath, [cli, 'self-host', '--configure-only', '--advertise', 'wss://100.127.255.254', '--port', String(port)], {
        env: { ...environment, HOME: secureHome, MUXR_HOME: secureHome }, timeout: 5000, stdio: 'pipe',
    }), /serves plain ws:\/\/ on the tailnet address/);
    assert.equal(existsSync(join(secureHome, 'selfhost.json')), false, 'a refused wss advertise wrote state');

    // A recorded non-public bind is reused by its owned relay: no second spawn.
    // 127.0.0.2 stands in for a tailnet address, which CI hosts do not have, and
    // a foreign listener on another loopback address must not be trusted.
    const rerunHome = join(scratch, 'private-rerun');
    mkdirSync(rerunHome, { mode: 0o700 });
    const rerunProbe = createServer();
    await new Promise((resolve) => rerunProbe.listen(0, '127.0.0.1', resolve));
    const rerunPort = rerunProbe.address().port;
    await new Promise((resolve) => rerunProbe.close(resolve));
    const rerunState = join(rerunHome, 'selfhost.json');
    execFileSync(process.execPath, [cli, 'self-host', '--configure-only', '--advertise', `ws://100.127.255.254:${rerunPort}`, '--port', String(rerunPort)], {
        env: { ...environment, HOME: rerunHome, MUXR_HOME: rerunHome }, timeout: 5_000, stdio: 'pipe',
    });
    const recorded = JSON.parse(readFileSync(rerunState, 'utf8'));
    writeFileSync(rerunState, `${JSON.stringify({ ...recorded, bindHost: '127.0.0.2', relayUrl: `ws://127.0.0.2:${rerunPort}` }, null, 2)}\n`, { mode: 0o600 });
    process.env.MUXR_HOME = rerunHome;
    const rerunHealth = async () => (await fetch(`http://127.0.0.2:${rerunPort}/health`, { signal: AbortSignal.timeout(2_000) })).json();
    try {
        await ensureSelfhostRelay(rerunPort, undefined, '127.0.0.2');
        const ownerPidFile = join(rerunHome, 'relay', 'relay.pid');
        const ownerPid = readFileSync(ownerPidFile, 'utf8');
        await ensureSelfhostRelay(rerunPort, undefined, '127.0.0.2');
        assert.equal(readFileSync(ownerPidFile, 'utf8'), ownerPid, 'setup spawned a second relay');
        const foreign = createHttpServer((request, response) => response.end(JSON.stringify({ ok: true })));
        await new Promise((resolve) => foreign.listen(rerunPort, '127.0.0.3', resolve));
        try {
            await assert.rejects(ensureSelfhostRelay(rerunPort, undefined, '127.0.0.3'), /is not a running muxr relay/);
        } finally {
            await new Promise((resolve) => foreign.close(resolve));
        }
        assert.equal(readFileSync(ownerPidFile, 'utf8'), ownerPid, 'foreign listener replaced the owned relay');
        assert.equal(JSON.parse(readFileSync(rerunState, 'utf8')).bindHost, '127.0.0.2');
    } finally {
        await stopOwnedSelfhostRelay();
        process.env.MUXR_HOME = scratch;
    }
} finally {
    await new Promise((resolve) => occupied.close(resolve));
    rmSync(scratch, { recursive: true, force: true });
}
process.stdout.write('selfhost state, stalled relay and headless configuration checks passed\n');
