/**
 * An agent pane that closes while the host opens its status watch must not
 * wedge the host (21 Oct: a 0.2.9 host served lists and Usage for hours while
 * every terminal attach waited forever, until the host was restarted).
 * Herdr answers a watch on a gone pane with an error whose id is the
 * subscription's own (`<id>:sub:0:probe`); a kit that never settles that watch
 * keeps its tree refresh running for good. Passive reads must not need that
 * refresh; the client's bootstrap guard must recover without a polling reader.
 * The guard restarts the kit on a trend of slow samples (3 x 20 s), not one, so
 * this check waits past that 60 s before it calls the read wedged.
 * Real lab Herdr and the host's Herdr client, built (`apps/host/dist`). A
 * socket proxy in front of the lab Herdr only holds one subscribe line back, so
 * the pane closes before Herdr reads it. (A whole lab host refuses any socket
 * but its lab session's own, so the client runs here on its own.)
 */
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createConnection, createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KitHerdrClient } from '../../../apps/host/dist/agent/infrastructure/herdrKitClient.js';

const helper = process.env.HERDR_LAB_HELPER;
if (!helper) throw new Error('HERDR_LAB_HELPER is not set: point it at a Herdr lab helper script.');
const root = mkdtempSync(join(tmpdir(), 'muxr-herdr-watch-'));
const workdir = join(root, 'cwd');
mkdirSync(join(workdir, 'bin'), { recursive: true });
const standIn = join(workdir, 'bin', 'claude');
writeFileSync(standIn, '#!/bin/sh\nwhile :; do sleep 3600; done\n', { mode: 0o755 });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const session = execFileSync(helper, ['name', 'herdr-watch'], { encoding: 'utf8' }).trim();
const wrapper = join(root, 'herdr-lab.sh');
writeFileSync(wrapper, `#!/bin/sh\nexec ${JSON.stringify(helper)} run ${JSON.stringify(session)} "$@"\n`);
chmodSync(wrapper, 0o700);
const herdr = (...args) => JSON.parse(execFileSync(wrapper, args, { encoding: 'utf8', timeout: 10_000 }));

async function until(check, label, timeout) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
        if (await check()) return;
        await sleep(250);
    }
    throw new Error(`timed out waiting for ${label}`);
}

// The client dials this proxy as its Herdr socket; every byte passes through
// except the doomed pane's status subscribe while holding.
let upstream;
let doomed;
let holding = false;
let watches = 0;
const held = [];
const proxyPath = join(root, 'herdr-proxy.sock');
const proxy = createServer((client) => {
    const server = createConnection(upstream);
    server.pipe(client);
    server.on('error', () => client.destroy());
    client.on('error', () => server.destroy());
    client.on('close', () => server.destroy());
    let pending = '';
    client.on('data', (chunk) => {
        pending += chunk;
        for (let end = pending.indexOf('\n'); end >= 0; end = pending.indexOf('\n')) {
            const line = pending.slice(0, end + 1);
            pending = pending.slice(end + 1);
            const watch = doomed !== undefined && line.includes('"events.subscribe"') && line.includes(`"pane_id":"${doomed}"`);
            if (watch) watches++;
            if (watch && holding) held.push(() => server.write(line));
            else server.write(line);
        }
    });
});
const release = () => { holding = false; for (const send of held.splice(0)) send(); };

let client;
try {
    execFileSync(helper, ['provision', session]);
    upstream = herdr('status', '--json').server.socket;
    await new Promise((resolve) => proxy.listen(proxyPath, resolve));
    client = new KitHerdrClient(() => wrapper, proxyPath, () => {});
    await client.start();

    // An agent pane the kit watches.
    doomed = herdr('workspace', 'create', '--cwd', workdir, '--label', 'doomed', '--no-focus').result.root_pane.pane_id;
    execFileSync(wrapper, ['pane', 'send-text', doomed, `${standIn}\n`]);
    await until(() => watches > 0, 'the host to watch the agent pane', 15_000);
    const healthy = Date.now();
    await client.refresh();
    process.stdout.write(`ok: the host watches the agent pane; a healthy tree read took ${((Date.now() - healthy) / 1000).toFixed(1)}s\n`);

    // A structural change re-reads the tree and re-opens every status watch;
    // the agent pane's watch is held while that pane closes.
    holding = true;
    const seen = watches;
    const trigger = herdr('workspace', 'create', '--cwd', workdir, '--label', 'trigger', '--no-focus').result.workspace.workspace_id;
    await until(() => watches > seen, 'the re-opened watch to be held', 15_000);
    herdr('pane', 'close', doomed);
    await sleep(500);
    release();

    // No refresh/list/attach may incidentally arm the guard here. An automatic
    // bootstrap must recover on its own, retaining the new live workspace.
    const asked = Date.now();
    await until(() => {
        const snapshot = client.kit.snapshot();
        return client.connected && snapshot.workspaces.some((workspace) => workspace.id === trigger)
            && !snapshot.workspaces.some((workspace) => workspace.tabs.some((tab) => tab.panes.some((pane) => pane.id === doomed)));
    }, 'automatic bootstrap recovery without a refreshing consumer', 90_000);
    const recoveryWaited = `${((Date.now() - asked) / 1000).toFixed(1)}s`;
    process.stdout.write(`ok: automatic bootstrap recovers ${recoveryWaited} after a watched agent pane closed, without a refreshing consumer\n`);
    const freshAsked = Date.now();
    const answered = await Promise.race([client.refresh().then(() => true), sleep(90_000).then(() => false)]);
    const waited = `${((Date.now() - freshAsked) / 1000).toFixed(1)}s`;
    if (!answered) throw new Error(`the Herdr tree refresh never answered after a watched agent pane closed (gave up after ${waited})`);
    process.stdout.write(`ok: an explicit fresh tree read still answers ${waited} after recovery\n`);
    process.stdout.write('PASS e2e: a vanished agent pane never wedges the Herdr tree\n');
} finally {
    const failures = [];
    for (const cleanup of [
        release,
        () => client?.close(),
        () => proxy.listening && new Promise((resolve, reject) => proxy.close((error) => error ? reject(error) : resolve())),
        () => execFileSync(helper, ['teardown', session]),
    ]) {
        try { await cleanup(); } catch (error) { failures.push(error); }
    }
    if (failures.length > 0) throw new AggregateError(failures, 'Herdr watch lab cleanup failed; scratch retained');
    rmSync(root, { recursive: true, force: true });
}
process.exit(0);
