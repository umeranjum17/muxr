// Pairs a native app to a private stack and cuts its link on demand. See terminal-reconnect.md.
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { setAndroidSerial } from './perf/lib/deviceTarget.mjs';
import { startFakeStack } from './perf/lib/fakeStack.mjs';
import { CommandScope, useCommandScope } from './perf/lib/commands.mjs';
import { waitForRelay } from './scripts/diagnostics/application/waitForRelay.mjs';

const { SERIAL, EVIDENCE } = process.env;
if (!EVIDENCE) throw new Error('Set EVIDENCE to the run evidence directory');
// No SERIAL: loopback, for a simulator or a host-only dry run.
if (SERIAL) setAndroidSerial(SERIAL);
const scope = new CommandScope();
useCommandScope(scope);
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => scope.abort());
const adb = (...args) => SERIAL ? scope.run('adb', ['-s', SERIAL, ...args]) : mark(`no device: skipped adb ${args[0]}`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const mark = (line) => {
    const stamped = `${new Date().toISOString()} lab: ${line}`;
    console.log(stamped);
    appendFileSync(join(EVIDENCE, 'lab-timeline.log'), `${stamped}\n`);
};
// Only lifecycle lines: the full logs carry pairing offers.
const KEEP = /^(link relay:|link: terminal stream|link unavailable|terminal:|relay listening)/;
const logLines = [];
const keep = (source) => (chunk) => {
    for (const line of String(chunk).split('\n')) {
        if (KEEP.test(line)) logLines.push(`${new Date().toISOString()} ${source}: ${line}`);
    }
};

try {
    const stack = await startFakeStack({ panes: 1, agents: 0, titleChurnHz: 0, transport: SERIAL ? 'adb' : 'loopback' });
    // The fake's shell pane, opened the way a link to it opens.
    const paneRoute = `shell:${stack.fixturePanes.text}`;
    const pairing = await stack.mintPairing();
    scope.cleanups.push(() => pairing.release());
    await adb('shell', 'am', 'start', '-a', 'android.intent.action.VIEW', '-d', `'muxr://pair#${pairing.code}'`, 'com.trymuxr.app');
    mark(`paired link opened; relay port ${stack.relayPort}; tap Pair, then enter: open | relay | net <seconds> | quit`);
    let relayPid = stack.pids.relay;
    const commands = {
        open: () => adb('shell', 'am', 'start', '-a', 'android.intent.action.VIEW',
            '-d', `'muxr:///session/${encodeURIComponent(paneRoute)}'`, 'com.trymuxr.app'),
        // Kill the relay by its exact PID and start it again on the same port and
        // data dir, as a service restart would.
        relay: async () => {
            mark(`relay restart: stopping pid ${relayPid}`);
            process.kill(relayPid, 'SIGTERM');
            await sleep(3_000);
            const env = { ...process.env };
            for (const key of Object.keys(env)) if (key.startsWith('MUXR_') || key === 'HERDR_SESSION') delete env[key];
            const relay = scope.spawn(process.execPath, ['apps/relay/dist/main.js'], {
                stdio: ['ignore', 'pipe', 'pipe'],
                env: {
                    ...env,
                    HOME: join(stack.root, 'home'),
                    XDG_CONFIG_HOME: join(stack.root, 'home', '.config'),
                    MUXR_HOME: join(stack.root, 'muxr'),
                    MUXR_NO_TUI: '1',
                    MUXR_NO_SERVICE_COMMANDS: '1',
                    MUXR_RELAY_PORT: String(stack.relayPort),
                    MUXR_RELAY_HOST: '127.0.0.1',
                    MUXR_RELAY_DATA_DIR: join(stack.root, 'muxr', 'relay'),
                    MUXR_RELAY_LOCAL_AUTHORITY: '1',
                    MUXR_RELAY_MDNS: '0',
                    MUXR_HOST_HTTP_URL: `http://127.0.0.1:${stack.hostHttpPort}`,
                },
            });
            relay.stdout.on('data', keep('relay'));
            relay.stderr.on('data', keep('relay'));
            const port = await waitForRelay(relay);
            if (port !== stack.relayPort) throw new Error(`relay came back on ${port}, not ${stack.relayPort}`);
            relayPid = relay.pid;
            mark(`relay restart: pid ${relayPid} listening on ${port}`);
        },
        // The phone loses its route to the relay, then gets it back.
        net: async (seconds = '20') => {
            mark(`network drop: removing tunnel for ${seconds}s`);
            await adb('reverse', '--remove', `tcp:${stack.relayPort}`);
            await sleep(Number(seconds) * 1_000);
            await adb('reverse', `tcp:${stack.relayPort}`, `tcp:${stack.relayPort}`);
            mark('network drop: tunnel restored');
        },
    };
    // fakeStack buffers its children's output; sample it so every line lands once.
    const seen = { host: 0, relay: 0 };
    const sample = () => {
        for (const [source, read] of [['host', stack.hostLog], ['relay', stack.relayLog]]) {
            const text = read();
            keep(source)(text.slice(seen[source]));
            seen[source] = text.length;
        }
    };
    const poll = setInterval(sample, 500);
    scope.cleanups.push(() => { clearInterval(poll); sample(); });
    const input = createInterface({ input: process.stdin });
    scope.cleanups.push(() => input.close());
    scope.signal.addEventListener('abort', () => input.close(), { once: true });
    for await (const line of input) {
        const [name, ...args] = line.trim().split(/\s+/);
        if (name === 'quit') break;
        if (!(name in commands)) { console.error('commands: open | relay | net <seconds> | quit'); continue; }
        await commands[name](...args).catch((error) => mark(`${name} failed: ${error.message}`));
    }
} catch (error) {
    if (!scope.signal.aborted) {
        console.error(error);
        process.exitCode = 1;
    }
} finally {
    try { await scope.close(); } finally {
        scope.cleanup();
        appendFileSync(join(EVIDENCE, 'host-relay.log'), `${logLines.join('\n')}\n`);
    }
}
