#!/usr/bin/env node
// Finds coloured regions in a rendered frame and reports them by hue.
//
//   node review/chroma.mjs review/frames/film-spend.png
//
// The set is meant to be neutral apart from status hues at dot size. This
// answers "how much colour, what hue, and where" with numbers, because the
// green that keeps coming back does not live in the palette file — it lives in
// the screenshots, and eyeballing a 1920px frame keeps missing it.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);

const files = process.argv.slice(2);
for (const file of files) {
    const { stdout: probe } = await exec('ffprobe', ['-v', 'error', '-select_streams', 'v',
        '-show_entries', 'stream=width,height', '-of', 'csv=p=0', file]);
    const [w, h] = probe.trim().split(',').map(Number);
    const { stdout } = await exec('ffmpeg', ['-v', 'error', '-i', file, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'],
        { maxBuffer: 1 << 28, encoding: 'buffer' });

    const buckets = new Map();
    let coloured = 0;
    for (let i = 0; i < stdout.length; i += 3) {
        const r = stdout[i], g = stdout[i + 1], b = stdout[i + 2];
        const max = Math.max(r, g, b), min = Math.min(r, g, b);
        const chroma = max - min;
        if (chroma < 26) continue;              // neutral enough to ignore
        coloured++;
        let hue;
        if (max === r) hue = ((g - b) / chroma + 6) % 6;
        else if (max === g) hue = (b - r) / chroma + 2;
        else hue = (r - g) / chroma + 4;
        hue = Math.round(hue * 60);
        const name = hue < 20 || hue >= 330 ? 'red' : hue < 45 ? 'orange' : hue < 70 ? 'yellow'
            : hue < 160 ? 'GREEN' : hue < 200 ? 'teal/cyan' : hue < 260 ? 'blue' : 'purple/magenta';
        const key = `${name}`;
        const e = buckets.get(key) ?? { n: 0, sample: [r, g, b], at: [Math.floor((i / 3) % w), Math.floor(i / 3 / w)] };
        e.n++;
        buckets.set(key, e);
    }
    const total = w * h;
    const rows = [...buckets.entries()].sort((a, b) => b[1].n - a[1].n)
        .map(([k, v]) => `${k} ${(v.n / total * 100).toFixed(2)}% #${v.sample.map((c) => c.toString(16).padStart(2, '0')).join('')} @${v.at}`);
    console.log(`${file.split('/').pop().padEnd(22)} colour ${(coloured / total * 100).toFixed(2)}%  ${rows.join('  |  ') || '(neutral)'}`);
}
