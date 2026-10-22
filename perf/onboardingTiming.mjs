#!/usr/bin/env node
/**
 * Time a new person's way from a fresh install to their first agent on a task-owned emulator.
 *
 * The phone runs the release APK, the computer is the fake-Herdr stack with a signed-in
 * `claude` stand-in and no agents (the same lab as features/home-first-agent.md). The clock
 * starts at app launch on a cleared app; the link arrives as a `muxr://pair#` intent (the
 * tap-a-link road; Paste and Scan end at the same consent screen). The lab ends at the
 * new agent's composer: the agent's own first answer comes from a real model, which muxr
 * does not control and a stand-in cannot honestly time.
 *
 * usage: node perf/onboardingTiming.mjs --apk [LABEL=]APP.apk [--apk LABEL=APP2.apk] --out DIR --avd-home DIR [--runs 3]
 * Run through the memory gate, as the emulator's lock holder.
 */
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { bootOwnedEmulator } from './lib/androidEmulator.mjs';
import { startFakeStack } from './lib/fakeStack.mjs';
import { setAndroidSerial } from './lib/deviceTarget.mjs';

const exec = promisify(execFile);
const arg = (name, fallback) => {
    const at = process.argv.indexOf(`--${name}`);
    return at === -1 ? fallback : process.argv[at + 1];
};
// --apk LABEL=PATH, repeated: each build is installed in turn on the same emulator and load.
const apks = process.argv.flatMap((value, at) => value === '--apk' ? [process.argv[at + 1]] : [])
    .map((spec) => (spec.includes('=') ? spec.split(/=(.*)/s) : ['build', spec]));
const out = arg('out');
const avdHome = arg('avd-home');
const runs = Number(arg('runs', '3'));
if (apks.length === 0 || !out || !avdHome) throw new Error('usage: node perf/onboardingTiming.mjs --apk [LABEL=]APP.apk [--apk LABEL=APP2.apk] --out DIR --avd-home DIR [--runs 3]');
mkdirSync(out, { recursive: true });
// The lab host must never reach a real sign-in: the stand-in answers every Claude call.
for (const key of Object.keys(process.env)) if (/^(CLAUDE|ANTHROPIC|CODEX|OPENAI)/.test(key)) delete process.env[key];

const PKG = 'com.trymuxr.app';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const CLAUDE = `#!/bin/sh
dir="\${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
if [ "$1" = auth ] && [ "$2" = status ]; then
  [ -f "$dir/lab-account.json" ] && { cat "$dir/lab-account.json"; exit 0; }
  echo '{"loggedIn":false,"authMethod":"none"}'; exit 1
fi
exec sleep 86400
`;

let serial;
/** Every change of what the screen shows, with its time: where a step's seconds go. */
const trail = [];
const adb = async (...args) => (await exec('adb', ['-s', serial, ...args], { timeout: 600_000, maxBuffer: 32 * 1024 * 1024 })).stdout;

async function dump() {
    try {
        return await adb('shell', 'uiautomator dump /sdcard/onb.xml >/dev/null 2>&1; cat /sdcard/onb.xml');
    } catch {
        return '';
    }
}
const nodes = (xml) => [...xml.matchAll(/<node\s[^>]*>/g)].map((match) => {
    const attr = (name) => new RegExp(`${name}="([^"]*)"`).exec(match[0])?.[1] ?? '';
    const b = /\[(\d+),(\d+)\]\[(\d+),(\d+)\]/.exec(attr('bounds'));
    return { text: attr('text'), desc: attr('content-desc'), x: b ? (+b[1] + +b[3]) / 2 : 0, y: b ? (+b[2] + +b[4]) / 2 : 0 };
});
const find = (xml, pattern) => nodes(xml).find((node) => pattern.test(node.text) || pattern.test(node.desc));

/** Poll until the pattern is on screen; returns the epoch ms it was first seen and the node. */
async function until(pattern, label, timeoutMs = 240_000) {
    const deadline = Date.now() + timeoutMs;
    let xml = '';
    while (Date.now() < deadline) {
        xml = await dump();
        const sig = nodes(xml).map((node) => node.text || node.desc).filter(Boolean).slice(0, 4).join(' | ');
        if (sig !== trail.at(-1)?.sig) trail.push({ at: Date.now(), sig });
        // A loaded emulator makes the launcher or SystemUI ANR over the app; Wait keeps the clock honest.
        const anr = /isn't responding/.test(xml) ? find(xml, /^Wait$/) : undefined;
        if (anr) { await adb('shell', 'input', 'tap', String(anr.x), String(anr.y)); continue; }
        const hit = find(xml, pattern);
        // The notification question can swallow a tap while it animates in: answer it again.
        const ask = !hit && /Allow muxr to send you notifications\?/.test(xml) ? find(xml, /^Allow$/) : undefined;
        // Wait out the dismissal: a second tap landing on Home would press whatever sits under the dialog.
        if (ask) { await adb('shell', 'input', 'tap', String(ask.x), String(ask.y)); await sleep(1500); continue; }
        if (hit) return { at: Date.now(), hit };
        await sleep(150);
    }
    writeFileSync(join(out, 'timeout-last-dump.xml'), xml);
    writeFileSync(join(out, 'timeout-last.png'), (await exec('adb', ['-s', serial, 'exec-out', 'screencap', '-p'], { encoding: 'buffer', maxBuffer: 32 * 1024 * 1024 })).stdout);
    throw new Error(`timed out waiting for ${label} (${pattern})`);
}

/** A real capture of what the person sees, kept for the first run of each build. */
async function shot(name) {
    mkdirSync(join(out, 'shots'), { recursive: true });
    writeFileSync(join(out, 'shots', `${currentLabel}-${name}.png`), (await exec('adb', ['-s', serial, 'exec-out', 'screencap', '-p'], { encoding: 'buffer', maxBuffer: 32 * 1024 * 1024 })).stdout);
}
let currentLabel = 'build';

async function oneRun(stack, run) {
    const steps = [];
    const failures = [];
    await adb('shell', 'pm', 'clear', PKG);
    const t0 = Date.now();
    const mark = (name, kind, from, to) => steps.push({ name, kind, ms: to - from });
    await adb('shell', 'am', 'start', '-n', `${PKG}/.MainActivity`);
    const first = (await until(/Have a connect link\?/, 'first screen')).at;
    if (run === 1) await shot('1-first-screen');
    mark('open the app to the first screen', 'wait', t0, first);

    const offer = await stack.mintPairing();
    try {
        let tap = Date.now();
        await adb('shell', 'am', 'start', '-a', 'android.intent.action.VIEW', '-d', `muxr://pair#${offer.code}`, '-n', `${PKG}/.MainActivity`);
        let seen = await until(/^Pair$/, 'consent screen');
        mark('open the link to the consent screen', 'tap', tap, seen.at);
        if (run === 1) await shot('2-consent');

        tap = Date.now();
        await adb('shell', 'input', 'tap', String(seen.hit.x), String(seen.hit.y));
        // Home or the system notification question, whichever comes first.
        seen = await until(/Allow muxr to send you notifications\?|Start your first agent|Start Claude Code|Can.t reach your computer/, 'paired');
        if (/Can.t reach/.test(seen.hit.text)) {
            // A lab-only hiccup (loaded emulator): record it, press Try again and time the second go.
            failures.push(`pair attempt failed after ${seen.at - tap} ms: ${seen.hit.text.slice(0, 40)}`);
            const again = find(await dump(), /^Try again$/);
            tap = Date.now();
            await adb('shell', 'input', 'tap', String(again.x), String(again.y));
            seen = await until(/Allow muxr to send you notifications\?|Start your first agent|Start Claude Code/, 'paired (retry)');
        }
        mark('tap Pair to the next screen', 'tap', tap, seen.at);
        const nextScreenAt = seen.at;
        if (run === 1) await shot('3-after-pair');

        if (/Allow muxr/.test(seen.hit.text)) {
            const allow = find(await dump(), /^Allow$/);
            tap = Date.now();
            await adb('shell', 'input', 'tap', String(allow.x), String(allow.y));
            seen = await until(/Start Claude Code/, 'one-tap start');
            if (run === 1) await shot('4-home-start');
            mark('answer the notification question to Start', 'tap', tap, seen.at);
        } else {
            seen = await until(/Start Claude Code/, 'one-tap start');
            if (run === 1) await shot('4-home-start');
            mark('wait for Start Claude Code', 'wait', nextScreenAt, seen.at);
        }

        tap = Date.now();
        await adb('shell', 'input', 'tap', String(seen.hit.x), String(seen.hit.y));
        seen = await until(/^Prompt/, 'agent composer');
        mark('tap Start to the agent composer', 'tap', tap, seen.at);
        if (run === 1) await shot('5-agent-composer');
        if (run === 1) {
            // Where the notification question lives now: back on Home with an agent running. Not part of the total.
            await adb('shell', 'input', 'keyevent', 'KEYCODE_BACK');
            const back = await until(/Allow muxr to send you notifications\?|Know when an agent needs you|Plan limits|Right now/, 'Home again');
            await sleep(1500);
            await shot('6-back-on-home');
            if (/Allow muxr/.test(back.hit.text)) {
                const allow = find(await dump(), /^Allow$/);
                await adb('shell', 'input', 'tap', String(allow.x), String(allow.y));
            }
        }
    } finally {
        offer.release();
    }
    const screens = trail.splice(0).map((row) => ({ ms: row.at - t0, screen: row.sig }));
    return { run, failures, screens, totalMs: steps.reduce((sum, step) => sum + step.ms, 0), steps };
}

const startLab = () => startFakeStack({
    transport: 'adb', panes: 0, agents: 0, titleChurnHz: 0,
    setupHome(home) {
        const bin = join(home, 'lab-bin');
        mkdirSync(bin, { recursive: true });
        writeFileSync(join(bin, 'claude'), CLAUDE);
        chmodSync(join(bin, 'claude'), 0o755);
        mkdirSync(join(home, '.claude'), { recursive: true });
        writeFileSync(join(home, '.claude/lab-account.json'), '{"loggedIn":true,"authMethod":"claude.ai","email":"umer@example.com","subscriptionType":"max"}\n');
        return { PATH: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin`, MUXR_MACHINE_NAME: 'Umer' };
    },
});

const emulator = await bootOwnedEmulator({
    name: 'onbtiming', avdHome, launcher: ['nice', '-n', '10'], maxEmulators: 99,
    systemImage: 'system-images;android-36;google_apis_playstore;x86_64',
});
serial = emulator.serial;
setAndroidSerial(serial);
let stack;
const stopAll = async () => {
    try { stack?.stop(); } catch { /* already gone */ }
    try { await emulator.stop(); } catch { /* already gone */ }
};
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => void stopAll().then(() => process.exit(1)));
try {
    // The reference phone: 1080x2376 at density 640 (270 x 594 dp).
    await adb('shell', 'wm', 'size', '1080x2376');
    await adb('shell', 'wm', 'density', '640');
    const report = [];
    for (const [label, apk] of apks) {
        await adb('shell', 'pm', 'uninstall', PKG).catch(() => undefined);
        const installStart = Date.now();
        await adb('push', apk, '/data/local/tmp/app.apk');
        await adb('shell', 'pm', 'install', '-r', '/data/local/tmp/app.apk');
        currentLabel = label;
        const entry = { label, installMs: Date.now() - installStart, results: [] };
        report.push(entry);
        for (let run = 1; run <= runs; run += 1) {
            // One computer per run: the first agent a run starts would retire the next run's card.
            stack = await startLab();
            try {
                entry.results.push(await oneRun(stack, run));
            } finally {
                stack.stop();
                stack = undefined;
            }
            await adb('shell', 'am', 'force-stop', PKG);
            writeFileSync(join(out, 'timing.json'), JSON.stringify(report, null, 2));
        }
        console.log(`== ${label}`);
        for (const result of entry.results) {
            console.log(`run ${result.run}: ${(result.totalMs / 1000).toFixed(1)} s`);
            for (const step of result.steps) console.log(`  ${step.kind.padEnd(4)} ${(step.ms / 1000).toFixed(1).padStart(5)} s  ${step.name}`);
        }
    }
} catch (error) {
    console.log('host log tail:', stack?.hostLog().split('\n').slice(-12).join('\n'));
    console.log('relay log tail:', stack?.relayLog().split('\n').slice(-12).join('\n'));
    throw error;
} finally {
    await stopAll();
}
