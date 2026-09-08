#!/usr/bin/env node
/**
 * The owned session a surface probe measures against.
 *
 * Preparation happens once, here, in a pane somebody is watching: the fake
 * world starts, the phone pairs, and this process stays alive holding both. It
 * writes a descriptor naming exactly what it prepared -- scenario, fixture,
 * candidate, host, plugins -- and every probe validates that descriptor before
 * it measures anything.
 *
 * It repairs nothing. A probe that finds this session gone reports an
 * incomplete probe; it never quietly re-pairs or rebuilds underneath a
 * measurement, which is how a warm loop starts lying about what it measured.
 */
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { CommandScope, useCommandScope } from './lib/commands.mjs';
import { startFakeStack } from './lib/fakeStack.mjs';
import { pairPhone } from './lib/pairPhone.mjs';
import { harnessIdentity, sha256, sourceIdentity } from './lib/provenance.mjs';
import { documentContract, documentPayload, DOCUMENT_FIXTURE, LOAD, SCENARIO_VERSION, scenarioSummary } from './lib/scenario.mjs';

const args = process.argv.slice(2);
const flag = (name, fallback) => {
    const index = args.indexOf(name);
    return index < 0 ? fallback : args[index + 1];
};
const platform = flag('--platform', 'android');
const apk = flag('--apk');
const descriptorPath = resolve(flag('--descriptor', '/tmp/muxr-probe-session.json'));
const MAESTRO = ['mise', ['x', 'maestro@cli-2.7.0', '--', 'maestro']];

if (!['android', 'ios'].includes(platform)) {
    process.stderr.write('usage: probeSession.mjs --platform android|ios [--apk <path>] [--descriptor <path>]\n');
    process.exit(2);
}

const scope = new CommandScope();
useCommandScope(scope);
const say = (line) => process.stdout.write(`${line}\n`);

function maestro(flow, variables = {}) {
    const [bin, prefix] = MAESTRO;
    const declared = Object.entries(variables).flatMap(([key, value]) => ['-e', `${key}=${value}`]);
    return new Promise((resolve_) => {
        const child = scope.spawn(bin, [...prefix, '--device', 'emulator-5554', 'test', ...declared, join('perf/flows', flow)], {
            env: { ...process.env, ANDROID_HOME: process.env.ANDROID_HOME ?? join(process.env.HOME, 'Android/Sdk') },
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        const output = [];
        child.stdout.on('data', (chunk) => output.push(String(chunk)));
        child.stderr.on('data', (chunk) => output.push(String(chunk)));
        child.once('close', (code) => resolve_({ code: code ?? 1, output: output.join('') }));
    });
}

const stack = await startFakeStack({
    ...LOAD,
    sourceRoot: process.cwd(),
    transport: platform === 'ios' ? 'loopback' : undefined,
    pluginsRoot: join(process.cwd(), 'plugins'),
});
writeFileSync(join(stack.world.cwd, DOCUMENT_FIXTURE), documentPayload());
say(scenarioSummary());
say(`herd up: ${stack.world.panes.length} panes, ${stack.world.agents.length} agents`);

if (stack.fixturePanes?.text === undefined || stack.fixturePanes?.graphics === undefined) {
    process.stderr.write('the herd published no text/graphics fixture panes\n');
    process.exit(1);
}

// Pairing is part of preparation, and its failure is reported here rather than
// retried inside a measurement.
let paired = { ok: true, skipped: true };
if (platform === 'android') {
    paired = await pairPhone({ stack, maestro });
    if (!paired.ok) {
        process.stderr.write(`pairing failed: ${paired.why}\n`);
        process.exit(1);
    }
    say(`paired in ${Math.round((paired.herdVisibleMs ?? 0) / 1000)}s`);
}

const descriptor = {
    version: 1,
    startedAt: new Date().toISOString(),
    pid: process.pid,
    platform,
    scenario: { version: SCENARIO_VERSION, load: LOAD, document: documentContract() },
    candidate: {
        ...(apk === undefined ? {} : { artifact: apk, sha256: sha256(apk) }),
        source: sourceIdentity('.'),
        harness: harnessIdentity('.'),
    },
    host: {
        relayPort: stack.relayPort,
        dataDir: stack.dataDir,
        cwd: stack.world.cwd,
        fixturePanes: stack.fixturePanes,
    },
    plugins: ['code', 'status', 'terminal-keys', 'attachments'],
    paired,
};
mkdirSync(dirname(descriptorPath), { recursive: true });
writeFileSync(descriptorPath, `${JSON.stringify(descriptor, null, 2)}\n`);
say(`session ready: ${descriptorPath}`);
say('probe it with: node perf/surfaceProbe.mjs --session '
    + `${descriptorPath} --platform ${platform} --surface document`);
say('this pane owns the session; leave it running and Ctrl-C to tear it down');

const teardown = () => {
    try { rmSync(descriptorPath, { force: true }); } catch { /* already gone */ }
    scope.cleanup();
    process.exit(0);
};
process.on('SIGINT', teardown);
process.on('SIGTERM', teardown);
// Hold the world open. Nothing else in this process does any measuring.
await new Promise(() => {});
