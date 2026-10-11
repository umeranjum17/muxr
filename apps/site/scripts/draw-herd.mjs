#!/usr/bin/env node
// Spot drawings of the herd for the site: fence lines, the lost lamb, the
// developer, the farm. They are drawn by the films' own engine and cast, so the
// pages and the films share one pen.
//
//   node scripts/draw-herd.mjs --source <herd films source dir (film/)>
//
// Each drawing is a transparent WebP at twice its display size, in a light
// variant (ink on the page's paper) and a dark one (the same drawing re-inked for
// the near-black page). Outputs are recorded under `herd` in marketing.lock.json,
// which `marketing:check` verifies and `marketing:sync` carries over untouched.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const ROOT = resolve(new URL('..', import.meta.url).pathname);
const LOCK = join(ROOT, 'marketing.lock.json');
const OUT = 'docs/herd';
const at = process.argv.indexOf('--source');
if (at === -1) throw new Error('usage: draw-herd.mjs --source <film source dir> [--only name]');
const SOURCE = resolve(process.argv[at + 1]);
const onlyAt = process.argv.indexOf('--only');
const ONLY = onlyAt === -1 ? undefined : process.argv[onlyAt + 1];

/** The engine and cast, in load order. */
const ENGINE = ['core.js', 'studio.js', 'cels.js', 'fonts.js', 'art.js', 'human.js', 'world.js', 'sets3.js'];
/** Dark re-inking: the films' paper colours onto the site's dark tokens. Ink
 *  becomes a warm grey that reads on the near-black page and on the wool alike. */
const DARK = {
    '#1d1b18': '#a9a59c', '#f3eee3': '#0c0c0b', '#4a4640': '#6f6b63', '#d9d2c1': '#1f1f1d', '#e6e4d2': '#161615',
    '#1c9f63': '#30d158', '#d9483b': '#ff453a', '#3d6fd6': '#0a84ff', '#fffdf6': '#1c1c1b', '#fffaf0': '#1c1c1b',
    // the farmhouse and its timber by night, so the lit window is the brightest thing
    '#fbf6ea': '#2b2926', '#e6dcc4': '#3d3a34', '#e9ddc4': '#3a362f', '#c9ab7e': '#7a6448', '#fbf8f1': '#e6e1d6',
};
/** His hair stays dark in the dark drawings, or he reads as grey-haired. */
const DARK_HAIR = [['fillPts(g, hair, INK', "fillPts(g, hair, '#2e2b27'"], ['[30, -48]], INK', "[30, -48]], '#2e2b27'"]];
const SPOTS = Object.entries(createRequire(import.meta.url)('./herd-spots.cjs').SIZES);

const chrome = ['chromium', 'google-chrome-stable', 'google-chrome'].find((bin) => {
    try { execFileSync('which', [bin], { stdio: 'ignore' }); return true; } catch { return false; }
});
if (!chrome) throw new Error('needs chromium or google-chrome on PATH');

const work = mkdtempSync(join(tmpdir(), 'draw-herd-'));
const sha256 = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');
const spots = readFileSync(join(ROOT, 'scripts', 'herd-spots.cjs'), 'utf8');
if (!ONLY) rmSync(join(ROOT, OUT), { recursive: true, force: true });
mkdirSync(join(ROOT, OUT), { recursive: true });

for (const theme of ['light', 'dark']) {
    const dir = join(work, theme);
    mkdirSync(dir);
    for (const file of ENGINE) {
        let text = readFileSync(join(SOURCE, file), 'utf8');
        if (theme === 'dark' && file !== 'core.js' && file !== 'fonts.js') {
            for (const [from, to] of Object.entries(DARK)) text = text.replaceAll(new RegExp(from, 'gi'), to);
            for (const [from, to] of DARK_HAIR) text = text.replaceAll(from, to);
        }
        writeFileSync(join(dir, file), text);
    }
    writeFileSync(join(dir, 'spots.js'), `const module = {};\n${spots}`);
    for (const [name, [w, h]] of SPOTS) {
        if (ONLY && name !== ONLY) continue;
        const page = join(dir, `${name}.html`);
        writeFileSync(page, `<!doctype html><meta charset="utf-8"><body>${ENGINE.map((f) => `<script src="${f}"></script>`).join('')}<script src="spots.js"></script>
<script>Promise.all(_photoLoads).then(async (faces) => { for (const f of faces) if (f && f.family) document.fonts.add(f); await document.fonts.ready;
const cv = document.createElement('canvas'); cv.width = ${w * 2}; cv.height = ${h * 2}; S = 2;
const c = cv.getContext('2d'); c.scale(2, 2); module.exports.DRAW[${JSON.stringify(name)}](c, ${w}, ${h});
document.body.textContent = 'PNG:' + cv.toDataURL('image/png') + ':END'; }).catch((e) => { document.body.textContent = 'ERR:' + e + ':END'; });</script>`);
        const dom = execFileSync(chrome, ['--headless=new', '--disable-gpu', '--allow-file-access-from-files', '--virtual-time-budget=8000', '--dump-dom', `file://${page}`],
            { maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] }).toString();
        const found = /(PNG|ERR):(.*?):END/s.exec(dom);
        if (!found || found[1] === 'ERR') throw new Error(`${name} (${theme}): ${found ? found[2] : 'no output'}`);
        const png = join(work, `${name}-${theme}.png`);
        writeFileSync(png, Buffer.from(found[2].split(',')[1], 'base64'));
        const target = join(ROOT, OUT, `${name}${theme === 'dark' ? '-dark' : ''}.webp`);
        execFileSync('magick', [png, '-strip', '-quality', '86', '-define', 'webp:alpha-quality=90', '-define', 'webp:method=6', target]);
    }
}
rmSync(work, { recursive: true, force: true });

const lock = JSON.parse(readFileSync(LOCK, 'utf8'));
const outputs = readdirSync(join(ROOT, OUT)).map((name) => `${OUT}/${name}`);
lock.herd = {
    source: 'Tales from the Herd film engine and cast, drawn by scripts/herd-spots.cjs',
    inputs: ENGINE.map((file) => ({ file, sha256: sha256(join(SOURCE, file)) })),
    outputs: outputs.sort().map((file) => ({ file, sha256: sha256(join(ROOT, file)) })),
};
writeFileSync(LOCK, `${JSON.stringify(lock, null, 4)}\n`);
process.stdout.write(`drew ${outputs.length} herd files into ${OUT}\n`);
