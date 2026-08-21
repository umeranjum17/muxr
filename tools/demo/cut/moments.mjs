#!/usr/bin/env node
// Finds the moment worth putting on camera, in every raw recording.
//
//   node cut/moments.mjs            all shots, both themes -> lib/moments.json
//   node cut/moments.mjs herd       just one
//
// The raw recordings run 30–37s and the app is only doing something for a few
// seconds of that: herd's swipes land at 8.4s, inbox's payload at 23.4s,
// terminal's agent output at 26.5s. Cutting a fixed window off the front picks
// dead air nearly every time, which is why the film reads as a slideshow of
// screenshots rather than an app doing something.
//
// So the cut point is found, not configured: score every frame for how much
// changed, then slide a window of the shot's own length across the timeline and
// take the position with the most life in it. That is what an editor does by
// scrubbing, and it is the difference between assembled and edited.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const exec = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * How closely each frame matches the shot's settled still, at 32x64 grey.
 *
 * Motion alone picks the wrong moment. The flows navigate and then act, so the
 * liveliest stretch of a recording is often the scroll on the way TO the
 * screen the shot is about — the voice window landed on the Herd list, the
 * diff window on a terminal. The captured still IS the destination screen, so
 * scoring similarity against it says "the right thing is on camera" and motion
 * says "and it is doing something". A shot needs both.
 */
async function similarity(file, stillPath) {
    const W = 48, H = 96, N = W * H;
    const grab = (input, extra) => exec('ffmpeg', ['-v', 'error', '-i', input,
        '-vf', `${extra}scale=${W}:${H},format=gray`, '-f', 'rawvideo', '-'],
        { maxBuffer: 1 << 28, encoding: 'buffer' }).then((r) => r.stdout).catch(() => Buffer.alloc(0));

    // Normalised cross-correlation, not absolute difference. Two dark screens
    // of the same app differ by very little in absolute terms — every frame
    // scored 0.9+ and the gate did nothing. Zero-meaning and unit-scaling both
    // sides first makes the score about structure, which is what "is this the
    // right screen" actually means.
    const norm = (buf, at) => {
        const v = new Float32Array(N);
        let mean = 0;
        for (let i = 0; i < N; i++) { v[i] = buf[at + i]; mean += v[i]; }
        mean /= N;
        let ss = 0;
        for (let i = 0; i < N; i++) { v[i] -= mean; ss += v[i] * v[i]; }
        const sd = Math.sqrt(ss / N) || 1;
        for (let i = 0; i < N; i++) v[i] /= sd;
        return v;
    };

    const stillBuf = await grab(stillPath, '');
    if (stillBuf.length < N) return undefined;
    const still = norm(stillBuf, 0);
    const frames = await grab(file, 'fps=30,');
    const out = [];
    for (let at = 0; at + N <= frames.length; at += N) {
        const cur = norm(frames, at);
        let dot = 0;
        for (let i = 0; i < N; i++) dot += cur[i] * still[i];
        out.push(Math.max(0, dot / N));
    }
    return out;
}

/** Per-frame "how much of the picture changed" at 30fps. */
async function score(file) {
    const { stderr } = await exec('ffmpeg', [
        '-v', 'info', '-i', file,
        '-vf', 'fps=30,tblend=all_mode=difference,signalstats,metadata=print:key=lavfi.signalstats.YAVG',
        '-f', 'null', '-',
    ], { maxBuffer: 1 << 28 }).catch((e) => ({ stderr: e.stderr ?? '' }));

    const out = [];
    let t = 0;
    for (const line of String(stderr).split('\n')) {
        const pts = line.match(/pts_time:([\d.]+)/);
        if (pts) t = Number(pts[1]);
        const val = line.match(/lavfi\.signalstats\.YAVG=([\d.]+)/);
        if (val) out.push({ t, v: Number(val[1]) });
    }
    return out;
}

/**
 * The best `seconds`-long window. Scored on total movement, but with a bonus
 * for movement that is still going at the end: a window that dies halfway
 * through reads as a shot that has finished before the cut does.
 */
function bestWindow(frames, seconds, match) {
    const n = Math.round(seconds * 30);
    if (frames.length <= n) return { start: 0, score: 0 };
    let best = { start: 0, score: -1 };
    for (let i = 0; i + n <= frames.length; i++) {
        const win = frames.slice(i, i + n);
        const total = win.reduce((a, f) => a + f.v, 0);
        const tail = win.slice(-Math.round(n / 3)).reduce((a, f) => a + f.v, 0);
        // Being on the right screen is a gate, not a tiebreak: a lively window
        // showing the wrong screen is worth nothing, so similarity is cubed.
        const on = match === undefined ? 1 : Math.pow(
            match.slice(i, i + n).reduce((a, v) => a + v, 0) / n, 3);
        const s = (total + tail * 0.6) * on;
        if (s > best.score) best = { start: frames[i].t, score: s };
    }
    return best;
}

const only = process.argv[2];
// Merge, never replace. Re-scoring one shot used to rewrite the file with just
// that shot in it, which silently sent every other window back to start=0 —
// and a window at 0 is the app still navigating, not the screen the shot is
// about.
const out = only
    ? JSON.parse(await readFile(path.join(root, 'lib/moments.json'), 'utf8').catch(() => '{}'))
    : {};
for (const theme of ['dark', 'light']) {
    const dir = path.join(root, 'raw', theme);
    const files = (await readdir(dir).catch(() => [])).filter((f) => f.endsWith('.mp4'));
    for (const file of files) {
        const id = file.replace('.mp4', '');
        if (only && id !== only) continue;
        const frames = await score(path.join(dir, file));
        if (!frames.length) { console.log(`${theme}/${id}: unreadable`); continue; }
        const match = await similarity(path.join(dir, file), path.join(root, 'reel/public/stills', theme, `${id}.png`));
        const peak = Math.max(...frames.map((f) => f.v));
        const windows = {};
        for (const sec of [1.5, 2, 2.5, 3, 3.5, 4, 5, 6, 9]) windows[sec] = Number(bestWindow(frames, sec, match).start.toFixed(2));
        out[`${theme}/${id}`] = {
            duration: Number(frames[frames.length - 1].t.toFixed(2)),
            peak: Number(peak.toFixed(2)),
            alive: Number((frames.filter((f) => f.v > peak * 0.08).length / frames.length).toFixed(3)),
            best: windows,
            onScreen: match === undefined ? null : Number((match.reduce((a, v) => a + v, 0) / match.length).toFixed(3)),
        };
        console.log(`${theme}/${id.padEnd(11)} ${out[`${theme}/${id}`].duration}s  peak ${peak.toFixed(1)}  best3s @ ${windows[3]}s`);
    }
}
await writeFile(path.join(root, 'lib/moments.json'), JSON.stringify(out, null, 2) + '\n');
console.log(`\nlib/moments.json — ${Object.keys(out).length} shots`);
