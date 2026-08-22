#!/usr/bin/env node
// Cuts shots 01-10 from the take.
//
//   node cut/shots.mjs           all of them
//   node cut/shots.mjs 02 05     just these
//
// Lengths come from lib/film.mjs and nothing here may disagree with it: a shot
// is rendered to exactly the frame count the table declares, so retiming the
// film means editing the table, never this file.
//
// What lives here is where each shot points and how it is framed. Two rules
// shape all of it. Real time: an in-point is a moment in the recording and the
// shot runs forward from it at 30fps, never sped up or slowed. And geometry
// holds: every desk shot crops the same 1920x1080 window out of the same
// render, so cutting between them does not shift the type.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SHOTS, FPS } from '../lib/film.mjs';

const exec = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(root, 'cut/shots');

const DESK = path.join(root, 'raw/take/desk-cfr.mp4');    // 1948x1948
const PHONE = path.join(root, 'raw/take/phone-cfr.mp4');  // 1080x2400
const AFTER = path.join(root, 'raw/take/phone-b-cfr.mp4'); // 1080x2400
const REST = path.join(root, 'raw/take/phone-c-cfr.mp4');  // 1080x2400

const INK = '0x0a0a0b';

/**
 * The desk window: 1920x1080 lifted straight out of the 1948-square render at
 * native size, anchored to the top. Nothing is scaled, so the type is exactly
 * the size agg drew it.
 *
 * Top, not bottom, because the pane is forty-eight rows and agg draws the last
 * twenty-three of them: the newest output lands at the top of the render and
 * the composer and status line trail off underneath. Anchoring to the bottom
 * frames the chrome and misses the work — which is what the first pass did.
 */
const DESK_CROP = 'crop=1920:1080:14:0';

/**
 * The phone window: a 1080x608 band of the screen filling the frame.
 *
 * The whole phone standing on ink is the prettier idea and it fails the only
 * rule that matters here — at 390px the film is 390px wide, a phone fitted to
 * that height is ninety-nine of them across, and nothing on it can be read.
 * A band at 1.78x puts phone type at roughly the size the desk terminal's type
 * lands at, which is the point of comparison that counts.
 */
const phoneBand = (y, h = 608) =>
    `crop=1080:${h}:0:${y},scale=-2:1080:flags=bicubic,pad=1920:1080:(ow-iw)/2:0:${INK}`;

/**
 * The take's own clock. The desk recording and the phone recording start
 * together and drift by a single frame across ten minutes, so phone times are
 * desk times: one number describes both.
 */
const TAP = 46.667;

/** Ten seconds of the job, and what is on the screen for each of them. */
const RECIPE = {
    // The fix being written. The screen is full of it: the task at the top, the
    // finding under it, the hunk landing line by line.
    '01': { src: DESK, at: 30.4, vf: DESK_CROP },

    // The macro. 900px of source across the frame is 2.1x, which is the widest
    // that still fits `Do you want to proceed?` — and option 2 runs off the
    // right edge, which is the shot: a question too big to miss.
    '02': { src: DESK, at: 39.0, vf: 'crop=900:506:60:1330,scale=1920:1080:flags=neighbor' },

    // Pull back: nobody answers, so the frame retreats from the macro until the
    // terminal is a fifth of the picture and the room around it is the subject.
    '03': { src: DESK, at: 42.1, pullback: true },

    // Match cut. Opens on the phone's own copy of the same question at the same
    // size, then retreats until the status bar, the header and the key row give
    // away what it has been on all along.
    '04': { src: PHONE, at: 39.0, reveal: true },

    // The hero. Desk and phone in one frame, both edge to edge, across the tap.
    '05': { src: DESK, at: TAP - 1.2, hero: true },

    // The desk recedes and the phone takes the whole frame. Transition only.
    '06': { src: DESK, at: TAP + 2.8, recede: true },

    // Work carries on without anyone at the desk: three states, hard cut.
    //
    // Three moments that are actually different. The obvious picks — 61s and
    // 96s — are the same screen twice: the agent asked its second question and
    // then sat there, so nothing moved between them. Progress you can see has
    // to be looked for, not assumed from the clock.
    '07': { band: 1180, states: [
        { src: PHONE, at: 47.6 },                 // the tests running
        { src: PHONE, at: 53.6 },                 // it asks a second question
        { src: AFTER, at: 10.5, band: 900 },      // and has written up the cause
    ] },

    // What it came to. The line the whole film is walking towards sits in the
    // middle of the frame: `pnpm test: 25 passed`.
    '08': { src: REST, at: 2.0, vf: phoneBand(620) },

    // The diff, in the light the Code panel renders it in.
    '09': { src: AFTER, at: 23.8, vf: phoneBand(380) },

    // And the session, green, among the others that are also running.
    // A little wider than the others: the group and its four rows come to 645px
    // and cropping to the standard band would cut the header off the top.
    '10': { src: AFTER, at: 40.6, vf: phoneBand(1385, 645) },
};

const H264 = ['-c:v', 'libx264', '-crf', '16', '-preset', 'slow',
    '-pix_fmt', 'yuv420p', '-r', String(FPS)];

/** A plain shot: one window of one recording, framed once and held. */
async function straight(shot, { src, at, vf }) {
    await exec('ffmpeg', ['-v', 'error', '-ss', String(at), '-i', src,
        '-frames:v', String(shot.frames), '-vf', `${vf},fps=${FPS}`,
        '-fps_mode', 'cfr', ...H264, '-y', path.join(OUT, `${shot.id}.mp4`)],
        { maxBuffer: 1 << 26 });
}

/** Three equal beats of the same recording, hard cut, framed identically. */
async function states(shot, { states: beats, band }) {
    const each = shot.frames / beats.length;
    if (!Number.isInteger(each)) throw new Error(`${shot.id}: ${shot.frames} does not divide by ${beats.length}`);
    const parts = [];
    for (const [index, beat] of beats.entries()) {
        const part = path.join(OUT, `.${shot.id}-${index}.mp4`);
        await exec('ffmpeg', ['-v', 'error', '-ss', String(beat.at), '-i', beat.src,
            '-frames:v', String(each), '-vf', `${phoneBand(beat.band ?? band)},fps=${FPS}`,
            '-fps_mode', 'cfr', ...H264, '-y', part], { maxBuffer: 1 << 26 });
        parts.push(part);
    }
    const list = path.join(OUT, `.${shot.id}.txt`);
    await exec('sh', ['-c', `printf "file '%s'\\n" ${parts.join(' ')} > ${list}`]);
    await exec('ffmpeg', ['-v', 'error', '-f', 'concat', '-safe', '0', '-i', list,
        '-c', 'copy', '-y', path.join(OUT, `${shot.id}.mp4`)]);
    await exec('rm', ['-f', list, ...parts]);
}

/**
 * Shots that move are built a frame at a time.
 *
 * Each frame is a separate ffmpeg call reading one source frame, which is slow
 * and completely predictable: frame N of the shot is frame N of the recording,
 * so a moving shot still runs at real speed. Anything smarter here risks
 * dropping or repeating source frames, and a shot that quietly retimes itself
 * is the one mistake in this film nobody would spot.
 */
async function moving(shot, plan, frame) {
    const dir = path.join(OUT, `.${shot.id}-frames`);
    await exec('rm', ['-rf', dir]);
    await mkdir(dir, { recursive: true });
    for (let n = 0; n < shot.frames; n += 1) {
        const t = plan.at + n / FPS;
        const { filter, inputs } = frame(n / (shot.frames - 1), n);
        const file = path.join(dir, `${String(n).padStart(4, '0')}.png`);
        await exec('ffmpeg', ['-v', 'error', ...inputs.flatMap((i) => ['-ss', String(t), '-i', i]),
            '-frames:v', '1', '-filter_complex', filter, '-y', file], { maxBuffer: 1 << 26 });
        // An empty 1920x1080 frame compresses to about 11kB. Anything near that
        // is a composite that did not composite, which is exactly the failure
        // that shipped a black hero shot once already — so it stops the render
        // rather than being discovered at the contact sheet.
        const { size } = await stat(file);
        if (size < 40_000) throw new Error(`${shot.id}: frame ${n} came out empty (${size} bytes)`);
    }
    await exec('ffmpeg', ['-v', 'error', '-framerate', String(FPS),
        '-i', path.join(dir, '%04d.png'), '-frames:v', String(shot.frames),
        ...H264, '-y', path.join(OUT, `${shot.id}.mp4`)], { maxBuffer: 1 << 26 });
    await exec('rm', ['-rf', dir]);
}

/** Ease-out: the move is quick to leave and slow to settle. */
const ease = (t) => 1 - (1 - t) ** 3;
const even = (n) => Math.max(2, Math.round(n / 2) * 2);
const mix = (a, b, t) => a + (b - a) * t;

/** Where shot 02's macro sits inside the desk render, in render pixels. */
const MACRO = { x: 60, y: 1330, w: 900, h: 506 };

/**
 * The desk's lower window — 1200px wide, and placed to hold both halves of the
 * hero: the question sits at render y 1378-1782 before the tap, and what
 * replaces it lands at y 731 after. One window covers both only here.
 */
const DESK_LOWER = 'crop=1200:1080:14:720';

/**
 * 03 — the frame retreats from the macro until the terminal is a fifth of it.
 *
 * Built as one continuous move rather than a cut down through sizes: the shot
 * is about nothing happening for a long time, and a move that never stops is
 * the only way to hold three seconds of that.
 */
async function pullback(shot, plan) {
    // The prompt went up at 37.4s and was answered at 46.7s. The counter shows
    // the real number of seconds it had been standing there, not a rounder one.
    const APPEARED = 37.4;
    const FONT = path.join(root, '../../apps/mobile/sources/assets/fonts/IBMPlexMono-Regular.ttf');
    // Start: 900px of render across the frame, centred on the question.
    // End: the whole render at a fifth of the frame's width, centred.
    const FROM = { k: 1920 / MACRO.w, ax: MACRO.x + MACRO.w / 2, ay: MACRO.y + MACRO.h / 2 };
    const TO = { k: (0.2 * 1920) / 1948, ax: 974, ay: 974 };
    await moving(shot, plan, (p, n) => {
        const t = ease(p);
        const k = mix(FROM.k, TO.k, t);
        const size = even(1948 * k);
        const x = Math.round(960 - mix(FROM.ax, TO.ax, t) * k);
        const y = Math.round(540 - mix(FROM.ay, TO.ay, t) * k);
        const waited = Math.floor(plan.at + n / FPS - APPEARED);
        // The colon separates drawtext's own options, so it is escaped here.
        const label = `WAITING FOR INPUT · 00\\:${String(waited).padStart(2, '0')}`;
        return {
            inputs: [DESK],
            filter: `[0:v]scale=${size}:${size}:flags=bicubic[t];`
                + `color=c=${INK}:s=1920x1080:d=1[bg];`
                + `[bg][t]overlay=${x}:${y},`
                + `drawtext=fontfile=${FONT}:text='${label}':fontcolor=0x8a8a90:fontsize=24`
                + `:x=(w-text_w)/2:y=852:alpha=${(0.85 * ease(Math.max(0, (p - 0.45) / 0.55))).toFixed(3)}`,
        };
    });
}

/**
 * 04 — the same question, the same size, and then it turns out to be a phone.
 *
 * The opening crop is 620px of phone across the frame, which puts the phone's
 * type at the height shot 02 leaves the desk's type at. That is the whole trick
 * of the cut: for the first half-second there is no way to tell which screen
 * you are looking at.
 */
async function reveal(shot, plan) {
    const FROM = { w: 620, h: 349, x: 0, y: 1760 };
    const TO = { w: 1080, h: 2400, x: 0, y: 0 };
    await moving(shot, plan, (p) => {
        const t = ease(p);
        const w = even(mix(FROM.w, TO.w, t));
        const h = even(mix(FROM.h, TO.h, t));
        const x = Math.round(mix(FROM.x, TO.x, t));
        const y = Math.round(mix(FROM.y, TO.y, t));
        // Fitted by height, then whatever is wider than the frame is trimmed
        // and whatever is narrower stands on ink.
        return {
            inputs: [PHONE],
            filter: `[0:v]crop=${w}:${h}:${x}:${y},scale=-2:1080:flags=bicubic,`
                + `crop=min(iw\\,1920):1080,pad=1920:1080:(ow-iw)/2:0:${INK}`,
        };
    });
}

/**
 * 05 — both screens at once, across the tap.
 *
 * 1200px of desk and 720px of phone, each running the full height of the frame.
 * Neither is scaled to fit the other: they are cropped to the part that carries
 * the question, so the two halves change within a frame of each other and you
 * can read both while they do.
 */
async function hero(shot, plan) {
    await moving(shot, plan, () => ({
        inputs: [DESK, PHONE],
        filter: `[0:v]${DESK_LOWER},pad=1920:1080:0:0:${INK}[bg];`
            + `[1:v]crop=1080:1620:0:780,scale=720:1080:flags=bicubic[p];`
            + `[bg][p]overlay=1200:0`,
    }));
}

/**
 * 06 — the desk lets go and the phone takes the frame.
 *
 * The desk shrinks, blurs and fades out of the left; the phone crops in from
 * its 720px column to the same band shot 07 opens on, so the cut into 07 lands
 * on identical geometry and reads as no cut at all.
 */
async function recede(shot, plan) {
    const BAND = 1180;
    await moving(shot, plan, (p) => {
        const t = ease(p);
        const deskW = even(mix(1200, 1200 * 0.55, t));
        const deskH = even(deskW * 1080 / 1200);
        const blur = (14 * t).toFixed(2);
        // The phone's crop opens from the hero's column out to the full band.
        const cw = even(mix(1080, 1080, t));
        const ch = even(mix(1620, 608, t));
        const cy = Math.round(mix(780, BAND, t));
        const pw = even(mix(720, 1920, t));
        const px = Math.round(mix(1200, 0, t));
        // The phone, padded out to the frame, is the ground the desk sits on:
        // a synthetic `color` source desynchronises whenever the seek lands on
        // an exact frame boundary and silently returns an empty frame.
        return {
            inputs: [DESK, PHONE],
            filter: `[1:v]crop=${cw}:${ch}:0:${cy},scale=${pw}:1080:flags=bicubic,`
                + `pad=1920:1080:${px}:0:${INK}[bg];`
                + `[0:v]${DESK_LOWER},scale=${deskW}:${deskH},gblur=sigma=${blur},`
                + `format=rgba,colorchannelmixer=aa=${(1 - t).toFixed(3)}[d];`
                + `[bg][d]overlay=0:(H-h)/2`,
        };
    });
}

await mkdir(OUT, { recursive: true });
const wanted = process.argv.slice(2);
for (const shot of SHOTS) {
    if (wanted.length > 0 && !wanted.includes(shot.id)) continue;
    const plan = RECIPE[shot.id];
    if (plan === undefined) continue;

    if (plan.states) await states(shot, plan);
    else if (plan.pullback) await pullback(shot, plan);
    else if (plan.reveal) await reveal(shot, plan);
    else if (plan.hero) await hero(shot, plan);
    else if (plan.recede) await recede(shot, plan);
    else await straight(shot, plan);

    const { stdout } = await exec('ffprobe', ['-v', 'error', '-select_streams', 'v',
        '-count_frames', '-show_entries', 'stream=nb_read_frames', '-of', 'csv=p=0',
        path.join(OUT, `${shot.id}.mp4`)]);
    const got = Number(stdout.trim());
    const ok = got === shot.frames ? 'ok' : `WRONG (table says ${shot.frames})`;
    console.log(`${shot.id}  ${String(got).padStart(4)} frames  ${(got / FPS).toFixed(1)}s  ${ok}`);
}
