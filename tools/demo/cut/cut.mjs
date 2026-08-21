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
import { scenes } from '../lib/scenes.mjs';

const exec = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const RAW = path.join(root, 'raw');
const OUT = path.join(root, 'reel', 'public', 'shots');

/** One shot slot in the reel, plus a tail so the last frame is never black. */
const SHOT_SECONDS = 6.4;
// Real time. Speeding a UI up reads as a product demo trying to hide how long
// something takes, and every multiple above 1 drags the window back through the
// navigation, so the shot spends its seconds on a screen it is not about.
const DEFAULT_SPEED = 1;

async function probeDuration(file) {
    const { stdout } = await exec('ffprobe', [
        '-v', 'error', '-select_streams', 'v:0',
        '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', file,
    ]);
    return Number.parseFloat(stdout.trim());
}

async function cutScene(scene) {
    const src = path.join(RAW, `${scene.id}.mp4`);
    await stat(src);

    let window = { actionStartMs: 0, actionEndMs: null };
    try {
        window = JSON.parse(await readFile(path.join(RAW, `${scene.id}.json`), 'utf8'));
    } catch {
        // Pre-timing capture, or a clip dropped in by hand: fall back to the file.
    }

    const total = await probeDuration(src);
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

    const out = path.join(OUT, `${scene.id}.mp4`);
    await exec('ffmpeg', [
        '-y', '-v', 'error',
        '-ss', start.toFixed(3),
        '-t', span.toFixed(3),
        '-i', src,
        '-map', '0:v:0',            // screenrecord ships two `mett` tracks alongside the video
        '-an',
        '-vf', `setpts=PTS/${speed},fps=30,format=yuv420p`,
        '-c:v', 'libx264', '-preset', 'slow', '-crf', '18',
        '-profile:v', 'high', '-g', '15',
        '-movflags', '+faststart',
        out,
    ], { maxBuffer: 1 << 26 });

    const cut = await probeDuration(out);
    console.log(`--> shots/${scene.id}.mp4  ${start.toFixed(1)}s +${span.toFixed(1)}s @${speed}x = ${cut.toFixed(2)}s`);
}

async function main() {
    const only = process.argv.slice(2);
    const shots = scenes.filter((s) => s.reel !== undefined);
    const chosen = only.length ? shots.filter((s) => only.includes(s.id)) : shots;
    if (!chosen.length) throw new Error(`no reel scenes matched ${only.join(', ')}`);

    await mkdir(OUT, { recursive: true });
    for (const scene of chosen) await cutScene(scene);
    console.log(`\ncut ${chosen.length} shot(s) into reel/public/shots`);
}

main().catch((e) => { console.error(e.message); process.exit(1); });
