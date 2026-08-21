#!/usr/bin/env node
// Where is a screen recording actually alive?
//
//   node review/motion.mjs reel/public/shots/dark/herd.mp4
//
// ffmpeg's scene-change score per frame, reported as a timeline. A studio cuts
// to the moment something happens, not to a timestamp — and these recordings
// are VFR, so a settled UI emits almost nothing for seconds at a time. This
// finds the seconds worth putting on camera.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);

for (const file of process.argv.slice(2)) {
    // signalstats on the delta between consecutive frames: high YAVG = lots moved.
    const { stderr } = await exec('ffmpeg', [
        '-v', 'info', '-i', file,
        '-vf', 'fps=30,tblend=all_mode=difference,signalstats,metadata=print:key=lavfi.signalstats.YAVG',
        '-f', 'null', '-',
    ], { maxBuffer: 1 << 28 }).catch((e) => ({ stderr: e.stderr ?? '' }));

    const scores = [];
    let t = 0;
    for (const line of String(stderr).split('\n')) {
        const pts = line.match(/pts_time:([\d.]+)/);
        if (pts) t = Number(pts[1]);
        const val = line.match(/lavfi\.signalstats\.YAVG=([\d.]+)/);
        if (val) scores.push([t, Number(val[1])]);
    }
    if (!scores.length) { console.log(`${file}: no frames read`); continue; }

    const peak = Math.max(...scores.map((s) => s[1]));
    const bars = ' ▁▂▃▄▅▆▇█';
    const strip = scores.map(([, v]) => bars[Math.min(8, Math.round((v / (peak || 1)) * 8))]).join('');
    // The liveliest one-second window is the one worth cutting to.
    let best = { at: 0, sum: -1 };
    for (let i = 0; i + 30 <= scores.length; i++) {
        const sum = scores.slice(i, i + 30).reduce((a, s) => a + s[1], 0);
        if (sum > best.sum) best = { at: scores[i][0], sum };
    }
    const alive = scores.filter((s) => s[1] > peak * 0.08).length;
    console.log(`${file.split('/').slice(-2).join('/').padEnd(20)} peak ${peak.toFixed(2)}  alive ${Math.round(alive / scores.length * 100)}%  best 1s @ ${best.at.toFixed(2)}s`);
    console.log(`  ${strip}`);
}
