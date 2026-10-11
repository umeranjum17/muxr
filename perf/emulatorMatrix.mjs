#!/usr/bin/env node
/**
 * Home on a busy host, measured on a real release phone: the native half of the
 * busy-computer proof.
 *
 * The host-side flows (perf/homeLoad.mjs, perf/artifactReplay.mjs) say what the
 * host sends. Only this run says what the phone's JS thread pays for it, by
 * installing a release APK on an emulator this process owns and sampling the
 * `mqt_v_js` thread over a quiet 300-pane herd for each built host.
 *
 * It always passes the host's own build as `sourceRoot`, so the two stages are
 * two host commits against one unchanged phone APK: the before/after of a
 * host-emission change, with the app held constant.
 *
 *   node perf/emulatorMatrix.mjs \
 *     --before-root /path/to/built/80aabd8c --after-root . \
 *     --apk /path/to/app-release.apk \
 *     --avd fm-emu-matrix --avd-home /path/to/avd --panes 300 --runs 3 --seconds 30 \
 *     --out report.json
 *
 * A host can start the emulator through its own launcher (memory gate, device
 * lock) with `--launcher "fm-mem-gate.sh"`.
 */
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { promisify } from 'node:util';
import { dirname, resolve } from 'node:path';
import { startFakeStack } from './lib/fakeStack.mjs';
import { samplePhase } from './lib/androidSignals.mjs';
import { bootOwnedEmulator } from './lib/androidEmulator.mjs';
import { androidArgs } from './lib/deviceTarget.mjs';

const run = promisify(execFile);
const args = process.argv.slice(2);
const flag = (name, fallback) => { const at = args.indexOf(name); return at < 0 ? fallback : args[at + 1]; };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const pkg = 'com.trymuxr.app';
const adb = async (...argv) => (await run('adb', androidArgs(argv), { timeout: 60_000, maxBuffer: 16 * 1024 * 1024 })).stdout;
const ui = async () => { await adb('shell', 'uiautomator', 'dump', '/sdcard/emu-matrix-ui.xml'); return adb('shell', 'cat', '/sdcard/emu-matrix-ui.xml'); };

const stages = [['before', resolve(flag('--before-root', ''))], ['after', resolve(flag('--after-root', '.'))]];
const apk = resolve(flag('--apk', ''));
const out = flag('--out', '');
const panes = Number(flag('--panes', '300'));
const runs = Number(flag('--runs', '3'));
const seconds = Number(flag('--seconds', '30'));
const report = { startedAt: new Date().toISOString(), pkg, panes, churn: 0, runs, seconds, apk, stages: Object.fromEntries(stages), results: [], failures: [] };
if (!existsSync(apk)) throw new Error(`release APK not found: ${apk}`);
for (const [name, root] of stages) if (!existsSync(resolve(root, 'apps/host/dist/main.js'))) throw new Error(`no built host under ${name} root ${root}`);

const until = async (ready, label, ms) => { const end = Date.now() + ms; while (Date.now() < end) { if (await ready()) return; await sleep(300); } throw new Error(`${label} timed out`); };
const tap = async (xml, label) => {
    const hit = [...xml.matchAll(/<node\s[^>]*>/g)].map((m) => m[0]).find((n) => new RegExp(`(?:text|content-desc)="${label}"`).test(n));
    if (hit === undefined) return false;
    const bounds = /bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/.exec(hit);
    if (bounds === null) return false;
    await adb('shell', 'input', 'tap', String(Math.round((+bounds[1] + +bounds[3]) / 2)), String(Math.round((+bounds[2] + +bounds[4]) / 2)));
    return true;
};

/** Type the host's minted offer into the real app; a pass is connected Home. */
async function pairNative(stack) {
    const offer = await stack.mintPairing();
    try {
        await adb('shell', 'am', 'force-stop', pkg);
        await adb('shell', 'pm', 'clear', pkg);
        await adb('shell', 'am', 'start', '-a', 'android.intent.action.VIEW', '-d', `muxr:///pair?offer=${encodeURIComponent(offer.code)}`, pkg);
        const end = Date.now() + 90_000;
        while (Date.now() < end) {
            const xml = await ui();
            if (/text="connected"/.test(xml) && /Pi 1|pi-1|LIVE|Live/.test(xml)) return;
            for (const label of ['Pair', 'PAIR', 'OK', 'CANCEL', "Don't allow", 'Not now', 'Continue', 'Get started']) {
                if (await tap(xml, label)) { await sleep(500); break; }
            }
            await sleep(500);
        }
        throw new Error('the offer never reached connected Home within 90s');
    } catch (error) {
        throw new Error(String(error.message).replaceAll(offer.code, '[offer]').replaceAll(encodeURIComponent(offer.code), '[offer]'));
    } finally { offer.release(); }
}

let emulator;
try {
    const launcher = flag('--launcher');
    emulator = await bootOwnedEmulator({
        name: flag('--avd', 'fm-emu-matrix'),
        avdHome: resolve(flag('--avd-home', '.emu-matrix-avd')),
        bootTimeoutMs: Number(flag('--boot-timeout-ms', '900000')),
        ...(launcher === undefined ? {} : { launcher: launcher.split(' ') }),
    });
    report.serial = emulator.serial;
    let installed = false;
    let installError = '';
    for (let attempt = 1; attempt <= 4 && !installed; attempt += 1) {
        try {
            const out = await adb('install', '-r', apk);
            if (/Success/.test(out)) { installed = true; break; }
            installError = out.trim();
        } catch (error) {
            installError = String(error.stderr ?? error.message).trim();
        }
        if (attempt < 4) await sleep(5000 * attempt);
    }
    if (!installed) throw new Error(`adb install failed after 4 attempts: ${installError}`);
    for (const setting of ['window_animation_scale', 'transition_animation_scale', 'animator_duration_scale']) await adb('shell', 'settings', 'put', 'global', setting, '0');
    for (const [name, sourceRoot] of stages) {
        for (let n = 1; n <= runs; n += 1) {
            let stack;
            try {
                stack = await startFakeStack({ sourceRoot, panes, agents: panes / 2, titleChurnHz: 0, terminalBytesPerSecond: 0, transport: 'adb', setupHome: () => ({ MUXR_MACHINE_NAME: 'Umer' }) });
                await until(() => stack.hostLog().includes('link relay: online'), 'host relay ready', 60_000);
                await pairNative(stack);
                await sleep(12_000);
                const sampled = await samplePhase({ pkg, seconds, intervalMs: 5000 });
                const entry = { stage: name, panes, churn: 0, run: n, jsBusyPercent: sampled.jsBusyPercent, sampledSeconds: sampled.sampledSeconds };
                report.results.push(entry);
                console.log(JSON.stringify(entry));
            } catch (error) {
                report.failures.push({ stage: name, run: n, error: error instanceof Error ? error.message : String(error) });
                throw error;
            } finally {
                await adb('shell', 'am', 'force-stop', pkg).catch(() => undefined);
                stack?.stop();
                await sleep(2000);
            }
        }
    }
} catch (error) {
    report.error = error instanceof Error ? error.message : String(error);
    process.exitCode = 1;
} finally {
    await emulator?.stop();
    report.finishedAt = new Date().toISOString();
    if (out) { mkdirSync(dirname(resolve(out)), { recursive: true }); writeFileSync(resolve(out), JSON.stringify(report, null, 2) + '\n'); }
    const cells = new Map(report.results.map((r) => [`${r.stage}-${r.run}`, r.jsBusyPercent]));
    console.log(`\nstage | ${Array.from({ length: runs }, (_, i) => `run ${i + 1}`).join(' | ')}`);
    for (const [name] of stages) console.log(`${name.padEnd(5)} | ${Array.from({ length: runs }, (_, i) => cells.get(`${name}-${i + 1}`) ?? '-').join(' | ')}`);
}
