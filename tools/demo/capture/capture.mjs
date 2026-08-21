#!/usr/bin/env node
// Drives the real app on a connected Android device with Maestro while adb
// records the screen, then pulls one clip + one settled still per scene.
//
// The app follows the system theme, so a run is per-theme and lands in
// raw/<theme>/. Both themes are shot because the film uses both: the product
// is one thing in two clothes, and saying so is more honest than picking one.
//
// Usage: node capture/capture.mjs [--theme light|dark] [sceneId ...]
//        node capture/capture.mjs --both
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

const argv = process.argv.slice(2);
const themeAt = argv.indexOf('--theme');
const BOTH = argv.includes('--both');
const THEMES = BOTH ? ['light', 'dark'] : [themeAt === -1 ? 'light' : argv[themeAt + 1]];
const only = argv.filter((a, i) => !a.startsWith('--') && i !== themeAt + 1);

// More than one emulator can be up — another session, another agent. Pin the
// device, or every adb call fails with "more than one device/emulator" halfway
// through a run.
const SERIAL = process.env.ANDROID_SERIAL ?? '';
const adbArgs = (args) => (SERIAL === '' ? args : ['-s', SERIAL, ...args]);
const sh = (args, opts = {}) => exec('adb', adbArgs(args), { maxBuffer: 1 << 26, ...opts });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// The phone status bar is cropped off every still as it is written. Staging it
// only trades one tell for another — 9:41 is Apple's keynote time on an Android
// listing, and the wifi glyph carries a "no internet" triangle on the assets
// selling a live self-hosted relay. Nothing above this line is product.
const STATUS_BAR = 100;

function startRecording() {
    const child = spawn('adb', adbArgs([
        'shell', 'screenrecord',
        '--bit-rate', '20000000',
        '--time-limit', '180',
        DEVICE_CLIP,
    ]), { stdio: ['ignore', 'pipe', 'pipe'] });
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
        if (SERIAL !== '') args.push('--device', SERIAL);
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
    const { stdout } = await exec('adb', adbArgs(['exec-out', 'screencap', '-p']), {
        maxBuffer: 1 << 27,
        encoding: 'buffer',
    });
    const tmp = `${outFile}.raw.png`;
    await writeFile(tmp, stdout);
    await exec('ffmpeg', ['-v', 'error', '-i', tmp, '-vf', `crop=1080:${2400 - STATUS_BAR}:0:${STATUS_BAR}`, '-y', outFile]);
    await rm(tmp, { force: true });
}

/** The app reads the system theme, so this is the whole switch. */
async function setTheme(theme) {
    await sh(['shell', 'cmd', 'uimode', 'night', theme === 'dark' ? 'yes' : 'no']);
    await sh(['shell', 'am', 'force-stop', 'com.trymuxr.app']).catch(() => { });
    await wait(1500);
}

async function captureScene(scene, theme) {
    const dir = path.join(RAW, theme);
    await mkdir(dir, { recursive: true });
    const flowPath = path.join(root, 'capture', 'flows', `${scene.id}.yaml`);
    console.log(`\n=== ${theme}/${scene.id} — ${scene.caption} ===`);

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
    await stopRecording(rec, path.join(dir, `${scene.id}.mp4`));

    if (flowError) throw flowError;

    await writeFile(path.join(dir, `${scene.id}.json`), JSON.stringify({
        id: scene.id,
        theme,
        actionStartMs: actionStartedAt - recordingStartedAt,
        actionEndMs: actionEndedAt - recordingStartedAt,
    }, null, 2));

    await wait(500);
    await still(path.join(dir, `${scene.id}.png`));
    console.log(`--> raw/${theme}/${scene.id}.mp4 (action ${((actionStartedAt - recordingStartedAt) / 1000).toFixed(1)}s–${((actionEndedAt - recordingStartedAt) / 1000).toFixed(1)}s) + raw/${scene.id}.png`);
}

async function main() {
    const chosen = only.length ? scenes.filter((s) => only.includes(s.id)) : scenes;
    if (!chosen.length) throw new Error(`no scenes matched ${only.join(', ')}`);

    const { stdout } = await exec('adb', ['devices']);
    if (SERIAL === '' && stdout.split('\n').filter((l) => /\bdevice$/.test(l.trim())).length > 1) {
        throw new Error('more than one device attached — set ANDROID_SERIAL');
    }
    if (!/\bdevice\b/.test(stdout.split('\n').slice(1).join('\n'))) {
        throw new Error('no adb device attached');
    }

    // The emulator's package verifier has been seen disabling the sideloaded
    // build mid-run, which surfaces as an opaque `launchApp failed: UNKNOWN`.
    await sh(['shell', 'pm', 'enable', 'com.trymuxr.app']).catch(() => { });

    await rm(path.join(RAW, '.keep'), { force: true });
    await mkdir(RAW, { recursive: true });
    try {
        for (const theme of THEMES) {
        await setTheme(theme);
        for (const scene of chosen) {
            // adb/Maestro drops a launch every so often on a busy emulator;
            // one retry costs a minute and saves re-running the whole set.
            try {
                await captureScene(scene, theme);
            } catch (error) {
                console.warn(`retrying ${scene.id}: ${error.message.split('\n')[0]}`);
                await wait(3000);
                await captureScene(scene, theme);
            }
        }
        }
    } finally {
        await setTheme('light');
    }
    console.log(`\ncaptured ${chosen.length} scene(s) x ${THEMES.length} theme(s) into ${RAW}`);
}

main().catch((e) => { console.error(e.message); process.exit(1); });
