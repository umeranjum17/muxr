#!/usr/bin/env node
// Drives the real app on a connected Android device with Maestro while adb
// records the screen, then pulls one clip + one settled still per scene.
//
// Usage: node capture/capture.mjs [sceneId ...]        (default: every scene)
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { scenes } from '../lib/scenes.mjs';

const exec = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const RAW = path.join(root, 'raw');
const DEVICE_CLIP = '/sdcard/muxr-demo.mp4';

const sh = (args, opts = {}) => exec('adb', args, { maxBuffer: 1 << 26, ...opts });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// A clean, deterministic status bar: 9:41, full battery, wifi, no notifications.
async function statusBar(mode) {
    const demo = (args) => sh(['shell', 'am', 'broadcast', '-a', 'com.android.systemui.demo', ...args]);
    if (mode === 'off') {
        await demo(['-e', 'command', 'exit']);
        return;
    }
    await sh(['shell', 'settings', 'put', 'global', 'sysui_demo_allowed', '1']);
    await demo(['-e', 'command', 'enter']);
    await demo(['-e', 'command', 'clock', '-e', 'hhmm', '0941']);
    await demo(['-e', 'command', 'battery', '-e', 'level', '100', '-e', 'plugged', 'false']);
    await demo(['-e', 'command', 'network', '-e', 'wifi', 'show', '-e', 'level', '4']);
    await demo(['-e', 'command', 'network', '-e', 'mobile', 'hide']);
    await demo(['-e', 'command', 'notifications', '-e', 'visible', 'false']);
}

function startRecording() {
    const child = spawn('adb', [
        'shell', 'screenrecord',
        '--bit-rate', '20000000',
        '--time-limit', '180',
        DEVICE_CLIP,
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
    let err = '';
    child.stderr.on('data', (b) => { err += b; });
    const exited = new Promise((resolve) => child.on('exit', (code) => resolve({ code, err })));
    return { child, exited };
}

async function stopRecording(rec, outFile) {
    // screenrecord only writes a playable moov atom when it is interrupted, not killed.
    await sh(['shell', 'pkill', '-SIGINT', 'screenrecord']).catch(() => { });
    await Promise.race([rec.exited, wait(8000)]);
    await wait(1200); // let the file flush on device
    await sh(['pull', DEVICE_CLIP, outFile]);
    await sh(['shell', 'rm', '-f', DEVICE_CLIP]).catch(() => { });
}

// Maestro takes ten-odd seconds to attach before it runs a single command, and
// that dead air lands in the middle of the recording. Report the moment the
// first command actually executes so the cut can start there.
const FIRST_COMMAND = /^\s*(Tap|Wait|Swipe|Assert|Launch|Open|Scroll|Press|Input|Copy|Run)/m;

function runFlow(flowPath, { env = {}, onFirstCommand } = {}) {
    return new Promise((resolve, reject) => {
        const args = ['test', flowPath, '--format', 'noop'];
        for (const [k, v] of Object.entries(env)) args.push('-e', `${k}=${v}`);
        const child = spawn('maestro', args, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
        let out = '';
        let announced = false;
        const scan = (chunk) => {
            if (announced || onFirstCommand === undefined) return;
            if (FIRST_COMMAND.test(String(chunk))) {
                announced = true;
                onFirstCommand();
            }
        };
        child.stdout.on('data', (b) => { out += b; scan(b); process.stdout.write(b); });
        child.stderr.on('data', (b) => { out += b; scan(b); process.stderr.write(b); });
        child.on('exit', (code) => (code === 0 ? resolve(out) : reject(new Error(`maestro exit ${code}\n${out}`))));
    });
}

async function still(outFile) {
    const { stdout } = await exec('adb', ['exec-out', 'screencap', '-p'], {
        maxBuffer: 1 << 27,
        encoding: 'buffer',
    });
    await writeFile(outFile, stdout);
}

async function captureScene(scene) {
    const flowPath = path.join(root, 'capture', 'flows', `${scene.id}.yaml`);
    console.log(`\n=== ${scene.id} — ${scene.caption} ===`);

    // Settle the app on a cold, connected Herd before the camera rolls, so every
    // clip starts from the same place and no relaunch is on film.
    const prelude = scene.prelude ?? 'home';
    if (prelude !== null) await runFlow(path.join(root, 'capture', 'flows', `${prelude}.yaml`));
    await wait(1200);

    const rec = startRecording();
    await wait(600); // screenrecord needs a beat before the first frame lands
    const recordingStartedAt = Date.now();
    let actionStartedAt = recordingStartedAt;
    let flowError;
    try {
        await runFlow(flowPath, {
            env: scene.env,
            onFirstCommand: () => { actionStartedAt = Date.now(); },
        });
    } catch (e) {
        flowError = e;
    }
    const actionEndedAt = Date.now();
    await wait(900); // hold the final frame
    await stopRecording(rec, path.join(RAW, `${scene.id}.mp4`));

    if (flowError) throw flowError;

    await writeFile(path.join(RAW, `${scene.id}.json`), JSON.stringify({
        id: scene.id,
        actionStartMs: actionStartedAt - recordingStartedAt,
        actionEndMs: actionEndedAt - recordingStartedAt,
    }, null, 2));

    await wait(500);
    await still(path.join(RAW, `${scene.id}.png`));
    console.log(`--> raw/${scene.id}.mp4 (action ${((actionStartedAt - recordingStartedAt) / 1000).toFixed(1)}s–${((actionEndedAt - recordingStartedAt) / 1000).toFixed(1)}s) + raw/${scene.id}.png`);
}

async function main() {
    const only = process.argv.slice(2);
    const chosen = only.length ? scenes.filter((s) => only.includes(s.id)) : scenes;
    if (!chosen.length) throw new Error(`no scenes matched ${only.join(', ')}`);

    const { stdout } = await exec('adb', ['devices']);
    if (!/\bdevice\b/.test(stdout.split('\n').slice(1).join('\n'))) {
        throw new Error('no adb device attached');
    }

    // The emulator's package verifier has been seen disabling the sideloaded
    // build mid-run, which surfaces as an opaque `launchApp failed: UNKNOWN`.
    await sh(['shell', 'pm', 'enable', 'com.trymuxr.app']).catch(() => { });

    await rm(path.join(RAW, '.keep'), { force: true });
    await mkdir(RAW, { recursive: true });
    await statusBar('on');
    try {
        for (const scene of chosen) {
            // adb/Maestro drops a launch every so often on a busy emulator;
            // one retry costs a minute and saves re-running the whole set.
            try {
                await captureScene(scene);
            } catch (error) {
                console.warn(`retrying ${scene.id}: ${error.message.split('\n')[0]}`);
                await wait(3000);
                await captureScene(scene);
            }
        }
    } finally {
        await statusBar('off');
    }
    console.log(`\ncaptured ${chosen.length} scene(s) into ${RAW}`);
}

main().catch((e) => { console.error(e.message); process.exit(1); });
