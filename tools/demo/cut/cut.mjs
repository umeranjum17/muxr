#!/usr/bin/env node
// Turns each raw screen recording into one shot-length clip for the reel.
//
// screenrecord gives us the whole session including the ten-odd seconds Maestro
// spends attaching, plus two `mett` metadata tracks that confuse editors. This
// trims to the window where something actually happened, drops everything but
// the video, and speeds it to exactly one shot slot.
//
// Usage: node cut/cut.mjs [sceneId ...]
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, mkdir, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { scenes, timing } from '../lib/scenes.mjs';

const exec = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const RAW = path.join(root, 'raw');
const OUT = path.join(root, 'reel', 'public', 'shots');
const THEMES = ['light', 'dark'];

/**
 * One shot slot in the film, plus a tail so the last frame is never black.
 * `timing.shot` frames at 30fps is what a shot actually plays; cutting longer
 * than that spends the extra at the START of the window, which is the
 * navigation, and the shot never reaches the screen it is about.
 */
const SHOT_SECONDS = timing.shot / 30 + 0.35;
// Real time. Speeding a UI up reads as a product demo trying to hide how long
// something takes, and every multiple above 1 drags the window back through the
// navigation, so the shot spends its seconds on a screen it is not about.
const DEFAULT_SPEED = 1;

/**
 * screenrecord's container duration overshoots its last video frame, sometimes
 * by the best part of a second. Cutting to the container value lands past the
 * end and yields a clip a few frames long, so take the shorter of the container
 * and the stream, and keep a frame of margin.
 */
async function probeDuration(file) {
    const { stdout } = await exec('ffprobe', [
        '-v', 'error', '-select_streams', 'v:0',
        '-show_entries', 'format=duration:stream=duration',
        '-of', 'default=nw=1:nk=1', file,
    ]);
    const values = stdout
        .split('\n')
        .map((line) => Number.parseFloat(line.trim()))
        .filter((n) => Number.isFinite(n) && n > 0);
    if (values.length === 0) throw new Error(`could not probe ${file}`);
    return Math.min(...values);
}

async function cutScene(scene, theme) {
    const src = path.join(RAW, theme, `${scene.id}.mp4`);
    await stat(src);

    let window = { actionStartMs: 0, actionEndMs: null };
    try {
        window = JSON.parse(await readFile(path.join(RAW, theme, `${scene.id}.json`), 'utf8'));
    } catch {
        // Pre-timing capture, or a clip dropped in by hand: fall back to the file.
    }

    const total = await probeDuration(src) - 0.12;
    const clip = scene.clip ?? {};
    const speed = clip.speed ?? DEFAULT_SPEED;
    const span = SHOT_SECONDS * speed;

    const actionStart = (window.actionStartMs ?? 0) / 1000;
    const actionEnd = Math.min(window.actionEndMs === null || window.actionEndMs === undefined
        ? total
        : window.actionEndMs / 1000 + 0.6, total);

    // Land on the payoff: the end of a flow is the screen the shot is about.
    let start = clip.start ?? Math.max(actionStart, actionEnd - span);
    if (start + span > total) start = Math.max(0, total - span);

    const out = path.join(OUT, theme, `${scene.id}.mp4`);
    await exec('ffmpeg', [
        '-y', '-v', 'error',
        '-i', src,
        '-map', '0:v:0',            // screenrecord ships two `mett` tracks alongside the video
        '-an',
        // Order matters. screenrecord emits a frame only when the screen
        // changes, so a settled UI can leave seconds of timeline with no packets
        // at all; trimming that directly returns the single held frame, or
        // nothing. Rebuild a constant frame rate first, then cut the window.
        '-vf', [
            'fps=30',
            `trim=start=${start.toFixed(3)}:duration=${span.toFixed(3)}`,
            `setpts=(PTS-STARTPTS)/${speed}`,
            'format=yuv420p',
        ].join(','),
        '-c:v', 'libx264', '-preset', 'slow', '-crf', '18',
        '-profile:v', 'high', '-g', '15',
        '-movflags', '+faststart',
        out,
    ], { maxBuffer: 1 << 26 });

    const cut = await probeDuration(out);
    const short = cut < SHOT_SECONDS - 0.35 ? '   << SHORT' : '';
    console.log(`--> shots/${theme}/${scene.id}.mp4  ${start.toFixed(1)}s +${span.toFixed(1)}s = ${cut.toFixed(2)}s${short}`);
}

async function main() {
    const only = process.argv.slice(2);
    const shots = scenes.filter((s) => s.reel !== undefined);
    const chosen = only.length ? shots.filter((s) => only.includes(s.id)) : shots;
    if (!chosen.length) throw new Error(`no reel scenes matched ${only.join(', ')}`);

    for (const theme of THEMES) {
        await mkdir(path.join(OUT, theme), { recursive: true });
        for (const scene of chosen) await cutScene(scene, theme);
    }
    console.log(`\ncut ${chosen.length} shot(s) x ${THEMES.length} theme(s) into reel/public/shots`);
}

main().catch((e) => { console.error(e.message); process.exit(1); });
