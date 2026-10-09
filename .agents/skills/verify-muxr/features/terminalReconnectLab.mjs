// Pairs a native app to a private stack and cuts its link on demand. See terminal-reconnect.md.
import { appendFileSync, existsSync, readFileSync, readlinkSync } from 'node:fs';
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
    mark(`paired link opened; relay port ${stack.relayPort}; tap Pair, then enter: open | relay [down s] | host [down s] | net <seconds> | quit`);
    const pids = { ...stack.pids };
    // Kill a service by its exact PID, keep it down for a while if asked, and start the same command line again, with
    // the same environment and working directory, as a service restart would.
    const restart = async (name, downSeconds = '0') => {
        const pid = pids[name];
        const argv = readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean);
        const env = Object.fromEntries(readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0').filter(Boolean)
            .map((entry) => [entry.slice(0, entry.indexOf('=')), entry.slice(entry.indexOf('=') + 1)]));
        const cwd = readlinkSync(`/proc/${pid}/cwd`);
        mark(`${name} restart: stopping pid ${pid}`);
        process.kill(pid, 'SIGTERM');
        while (existsSync(`/proc/${pid}`)) await sleep(200);
        await sleep(Number(downSeconds) * 1_000);
        // The relay's port is pinned so the phone's tunnel still reaches it.
        if (name === 'relay') env.MUXR_RELAY_PORT = String(stack.relayPort);
        const child = scope.spawn(argv[0], argv.slice(1), { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
        child.stdout.on('data', keep(name));
        child.stderr.on('data', keep(name));
        if (name === 'relay') {
            const port = await waitForRelay(child);
            if (port !== stack.relayPort) throw new Error(`relay came back on ${port}, not ${stack.relayPort}`);
        }
        pids[name] = child.pid;
        mark(`${name} restart: pid ${child.pid} started`);
    };
    const commands = {
        open: () => adb('shell', 'am', 'start', '-a', 'android.intent.action.VIEW',
            '-d', `'muxr:///session/${encodeURIComponent(paneRoute)}'`, 'com.trymuxr.app'),
        relay: (seconds) => restart('relay', seconds),
        host: (seconds) => restart('host', seconds),
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
        if (!(name in commands)) { console.error('commands: open | relay [down s] | host [down s] | net <seconds> | quit'); continue; }
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
