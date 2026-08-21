#!/usr/bin/env node
// Grid audit. Reads a rendered frame, finds the horizontal runs of non-ground
// pixels on a few scan rows, and reports how far each edge sits from the
// nearest column line. Anything over 1px off-grid is a rubric failure, so this
// answers the "is it actually on the grid" question with a number instead of
// an opinion.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);

const [, , file, kind = 'film'] = process.argv;
const G = kind === 'store'
    ? { w: 1080, h: 1920, cols: 6, margin: 72, gutter: 24 }
    : { w: 1920, h: 1080, cols: 12, margin: 120, gutter: 48 };
const cw = (G.w - G.margin * 2 - G.gutter * (G.cols - 1)) / G.cols;
const lines = [];
for (let n = 1; n <= G.cols; n++) {
    lines.push({ label: `c${n}`, x: G.margin + (n - 1) * (cw + G.gutter) });
    lines.push({ label: `c${n}end`, x: G.margin + (n - 1) * (cw + G.gutter) + cw });
}

const { stdout } = await exec('ffmpeg', ['-v', 'error', '-i', file, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], {
    maxBuffer: 1 << 28, encoding: 'buffer',
});
const buf = stdout;
const at = (x, y) => { const i = (y * G.w + x) * 3; return [buf[i], buf[i + 1], buf[i + 2]]; };
const bg = at(4, 4);
const near = (x) => lines.reduce((b, l) => (Math.abs(l.x - x) < Math.abs(b.x - x) ? l : b));

for (const row of [Math.round(G.h * 0.25), Math.round(G.h * 0.5), Math.round(G.h * 0.75)]) {
    const runs = [];
    let start = null;
    for (let x = 0; x < G.w; x++) {
        const p = at(x, row);
        const d = Math.abs(p[0] - bg[0]) + Math.abs(p[1] - bg[1]) + Math.abs(p[2] - bg[2]);
        if (d > 14 && start === null) start = x;
        else if (d <= 14 && start !== null) { if (x - start > 6) runs.push([start, x]); start = null; }
    }
    if (start !== null) runs.push([start, G.w]);
    const merged = runs.reduce((acc, r) => {
        const last = acc[acc.length - 1];
        if (last && r[0] - last[1] < 40) { last[1] = r[1]; return acc; }
        return [...acc, r];
    }, []);
    console.log(`y=${row}`, merged.map(([a, b]) => {
        const la = near(a), lb = near(b);
        return `${a}–${b} [${la.label}${a - la.x >= 0 ? '+' : ''}${Math.round(a - la.x)} .. ${lb.label}${b - lb.x >= 0 ? '+' : ''}${Math.round(b - lb.x)}]`;
    }).join('  '));
}
