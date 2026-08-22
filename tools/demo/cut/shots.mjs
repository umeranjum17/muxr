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
import { mkdir, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SHOTS, FPS, DISSOLVE } from '../lib/film.mjs';

const exec = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(root, 'cut/shots');

const DESK = path.join(root, 'raw/take/desk-cfr.mp4');    // 1948x1948
const PHONE = path.join(root, 'raw/take/phone-cfr.mp4');  // 1080x2400
const AFTER = path.join(root, 'raw/take/phone-after-cfr.mp4'); // 1080x2400
const DIFF = path.join(root, 'raw/take/phone-diff-cfr.mp4');   // 1080x2400

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
/**
 * Upscaled with lanczos and then sharpened, because the band is blown up
 * 1.5-1.8x from a lossy screen recording and sits in the film next to a desk
 * render that is pixel-for-pixel — soft phone text against crisp terminal
 * text reads as a quality drop, not a style.
 */
const phoneBand = (y, h = 608) =>
    `crop=1080:${h}:0:${y},scale=-2:1080:flags=lanczos,`
    + `unsharp=5:5:0.6:5:5:0.0,pad=1920:1080:(ow-iw)/2:0:${INK}`;

/**
 * The take's own clock. The desk recording and the phone recording start
 * together and drift by a single frame across ten minutes, so phone times are
 * desk times: one number describes both.
 */
const TAP = 96.1;

/** The job's moments, on the take's clock. `cut/timeline.mjs` prints them. */
const RECIPE = {
    // Claude mid-work: the test hunk landing line by line, screen full.
    'f1': { src: DESK, at: 49.4, vf: DESK_CROP },

    // The macro. 900px of source across the frame is 2.1x, which is the widest
    // that still fits `Do you want to proceed?` — option 2 runs off the right
    // edge, which is the shot: a question too big to miss.
    'f2': { src: DESK, at: 52.5, vf: 'crop=900:506:60:1330,scale=1920:1080:flags=neighbor' },

    // Pull back: nobody answers. The counter reads the real wait — the prompt
    // stood 45.2s before the tap.
    'f3': { src: DESK, at: 92.0, pullback: true },

    // The same question, revealed to be on a phone.
    'f4': { src: PHONE, at: 91.0, reveal: true },

    // The hero. Both screens across the tap; an authored touch-dot pulses on
    // the phone's Enter at the exact tap frame — the card primes where to
    // look, the dot marks when it happened.
    'f5': { src: DESK, at: TAP - 1.2, hero: true },

    // The work finishing: tests running, then the write-up with `26 passed`.
    'f6': { band: 1180, states: [
        { src: PHONE, at: 101.4 },
        { src: AFTER, at: 5.0, band: 1150 },
    ] },

    // The Herd: four agents, live dots, auth-fix green among them.
    'f7': { src: AFTER, at: 35.2, vf: phoneBand(1390, 645) },
};

const H264 = ['-c:v', 'libx264', '-crf', '16', '-preset', 'slow',
    '-pix_fmt', 'yuv420p', '-r', String(FPS)];

/**
 * A plain shot: one window of one recording, framed once and — since the film
 * went to Apple pacing — pushed into slowly rather than held dead. `extra`
 * frames beyond the table's count are cut for the shot that feeds the
 * dissolve; the blend consumes them.
 */
async function straight(shot, { src, at, vf, push = 0.03 }, extra = 0) {
    const frames = shot.frames + extra;
    await moving({ ...shot, frames }, { at }, (p) => ({
        inputs: [src],
        filter: `[0:v]${vf},${pushTo(p, push)}`,
    }));
}

/**
 * Equal beats of the same recording, hard cut, framed identically — each with
 * its own small push, restarting on the cut, which is what sells the beats as
 * separate glances rather than one recording chopped up.
 */
async function states(shot, { states: beats, band }) {
    const each = shot.frames / beats.length;
    if (!Number.isInteger(each)) throw new Error(`${shot.id}: ${shot.frames} does not divide by ${beats.length}`);
    await moving(shot, { at: 0 }, (_, n) => {
        const beat = beats[Math.floor(n / each)];
        const local = (n % each) / (each - 1);
        return {
            at: beat.at + (n % each) / FPS,
            inputs: [beat.src],
            filter: `[0:v]${phoneBand(beat.band ?? band)},${pushTo(local, 0.02)}`,
        };
    });
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
    await rm(dir, { recursive: true, force: true });
    await mkdir(dir, { recursive: true });
    for (let n = 0; n < shot.frames; n += 1) {
        const spec = frame(n / (shot.frames - 1), n);
        const t = spec.at ?? plan.at + n / FPS;
        const { filter, inputs } = spec;
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
    await rm(dir, { recursive: true, force: true });
}

/** Ease-out: the move is quick to leave and slow to settle. */
const ease = (t) => 1 - (1 - t) ** 3;
const even = (n) => Math.max(2, Math.round(n / 2) * 2);
const mix = (a, b, t) => a + (b - a) * t;

/**
 * A slow push-in: the frame creeps from 100% to 100+z% and is cropped back to
 * 1920x1080, so a held shot breathes instead of sitting dead. Linear on
 * purpose — constant velocity reads as calm; an eased push reads as a camera
 * operator arriving.
 */
const pushTo = (p, z) => {
    const k = 1 + z * p;
    return `scale=${even(1920 * k)}:${even(1080 * k)}:flags=bicubic,`
        + `crop=1920:1080:(iw-1920)/2:(ih-1080)/2`;
};

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
    const APPEARED = 50.94;
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
    const FROM = { w: 620, h: 349, x: 0, y: 1795 };
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
            filter: `[0:v]crop=${w}:${h}:${x}:${y},scale=-2:1080:flags=lanczos,`
                + `unsharp=5:5:0.5:5:5:0.0,`
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
    // Where the phone's Enter key lands in the composed frame: screen (476,
    // 2112) → crop y-780 → scale 2/3 → column at x1200.
    // Starts three frames before the desk reacts, so cause precedes effect.
    const DOT = { x: 1517, y: 888, at: 33, frames: 16 };
    await moving(shot, plan, (p, n) => {
        let dot = '';
        if (n >= DOT.at && n < DOT.at + DOT.frames) {
            const t = (n - DOT.at) / (DOT.frames - 1);
            const r = Math.round(30 + 44 * t);
            const alpha = (0.7 * (1 - t) ** 1.5).toFixed(3);
            // An ink pulse, because it lands on the light key row — the first
            // version was white and vanished into the keys it was pointing at.
            dot = `,drawbox=x=${DOT.x - r}:y=${DOT.y - r}:w=${2 * r}:h=${2 * r}`
                + `:color=0x0a0a0b@${alpha}:t=6`;
        }
        return {
            inputs: [DESK, PHONE],
            filter: `[0:v]${DESK_LOWER},pad=1920:1080:0:0:${INK}[bg];`
                + `[1:v]crop=1080:1620:0:780,scale=720:1080:flags=lanczos[p];`
                + `[bg][p]overlay=1200:0${dot},${pushTo(p, 0.02)}`,
        };
    });
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

    const extra = shot.id === DISSOLVE.from ? DISSOLVE.frames : 0;
    if (plan.states) await states(shot, plan);
    else if (plan.pullback) await pullback(shot, plan);
    else if (plan.reveal) await reveal(shot, plan);
    else if (plan.hero) await hero(shot, plan);
    else if (plan.recede) await recede(shot, plan);
    else await straight(shot, plan, extra);

    const { stdout } = await exec('ffprobe', ['-v', 'error', '-select_streams', 'v',
        '-count_frames', '-show_entries', 'stream=nb_read_frames', '-of', 'csv=p=0',
        path.join(OUT, `${shot.id}.mp4`)]);
    const got = Number(stdout.trim());
    const want = shot.frames + (shot.id === DISSOLVE.from ? DISSOLVE.frames : 0);
    const ok = got === want ? 'ok' : `WRONG (want ${want})`;
    console.log(`${shot.id}  ${String(got).padStart(4)} frames  ${(got / FPS).toFixed(1)}s  ${ok}`);
}
