#!/usr/bin/env node
// Fails if a shipped frame contains the machine owner's relay host.
//
//   node review/leakcheck.mjs review/reel/*.png review/frames/*.png
//   node review/leakcheck.mjs raw/muxr-demo-1080.mp4      every frame of it
//
// The Connection screen prints the relay you are actually paired to, which on
// a developer's machine is their own tailnet hostname. Painting over it was
// tried and abandoned: the row sits at a different height in almost every
// frame, so one fixed box paints unrelated rows and still misses the one that
// matters. Framing the shot so the row is never on camera is simpler and
// honest — nothing in the film is doctored. This is the check that keeps it
// that way, by reading the shipped pixels rather than trusting the crop.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const exec = promisify(execFile);

/**
 * The placeholders a masked capture is allowed to show, in full.
 *
 * Both spellings are listed because OCR routinely drops the leading label, so
 * `your-host.ts.net` reads as `host.ts.net` about half the time. Compared whole
 * rather than by substring: `evil-host.ts.net` contains `host.ts.net`, and a
 * check that lets that through is worse than no check.
 */
const PLACEHOLDERS = new Set(['host.ts.net', 'your-host.ts.net']);
/**
 * Any tailnet-looking host that is not the placeholder. Matching a bare
 * `.ts.net` flags the placeholder itself, which is the one string that is
 * meant to be there.
 */
const HOSTS = /\b([a-z0-9-]+\.)?[a-z0-9-]*\.ts\.net\b/gi;
const EXTRA = (process.env.MUXR_RELAY_HOST?.trim() || 'tail0de54').toLowerCase();

/**
 * Everything else a shipped frame must never carry.
 *
 * Shot 01 passed the first version of this check while a Claude session URL sat
 * across two lines of the frame, perfectly legible — the check only knew about
 * relay hosts. A leak check that only looks for what you already thought of is
 * a check that passes right up until it matters.
 */
const FORBIDDEN = [
    { name: 'agent session URL', re: /claude\.ai\/code\/session[_-][A-Za-z0-9]+/i },
    { name: 'home directory path', re: /\/home\/(?!user\b)[a-z][a-z0-9_-]{1,31}\//i },
    { name: 'muxr pane id', re: /\bterm_[0-9a-f]{8,}\b/i },
    { name: 'bearer token', re: /\b(bearer|api[_-]?key|secret)\b[\s:=]+\S{8,}/i },
    { name: 'private ip', re: /\b(10|192\.168|172\.(1[6-9]|2\d|3[01]))\.\d{1,3}\.\d{1,3}\b/ },
];

/**
 * The machine owner's own name, whoever they are.
 *
 * Claude Code greets you by name on its opening banner, so the name is one
 * scroll away from every desk shot in the film. Taken from git rather than
 * written down here: hardcoding it would put the thing being protected into
 * the file that protects it.
 */
const OWNER = await exec('git', ['config', 'user.name'])
    .then((r) => r.stdout.trim().toLowerCase())
    .catch(() => '');
if (OWNER.length > 2) {
    FORBIDDEN.push({ name: 'account holder name', re: new RegExp(OWNER.replace(/\s+/g, '\\s*'), 'i') });
}

const given = process.argv.slice(2);
if (given.length === 0) {
    console.error('usage: leakcheck.mjs <image|video>...');
    process.exit(2);
}

/**
 * A video is checked frame by frame, not sampled.
 *
 * Sampling is how a leak ships: the row that names the machine is on screen
 * for a handful of frames and every one of them is a frame somebody can pause
 * on. The brief says every shipped frame, so every shipped frame is read.
 */
const files = [];
for (const item of given) {
    if (!/\.(mp4|mov|webm)$/i.test(item)) { files.push(item); continue; }
    const dir = await mkdtemp(path.join(tmpdir(), 'leakcheck-'));
    await exec('ffmpeg', ['-v', 'error', '-i', item, '-fps_mode', 'passthrough',
        path.join(dir, '%05d.png')], { maxBuffer: 1 << 26 });
    const frames = (await readdir(dir)).sort().map((f) => path.join(dir, f));
    console.log(`${item} — ${frames.length} frames`);
    files.push(...frames);
}

let failures = 0;
for (const file of files) {
    // tesseract is the only dependency and it is optional, but a missing OCR
    // has to read as "could not check", never as "passed".
    const text = await exec('tesseract', [file, 'stdout', '--psm', '11'], { maxBuffer: 1 << 26 })
        .then((result) => result.stdout)
        .catch(() => undefined);
    if (text === undefined) {
        console.error(`?? ${file}: OCR unavailable, not checked`);
        failures += 1;
        continue;
    }
    const lower = text.toLowerCase();
    const hosts = [...lower.matchAll(HOSTS)].map((m) => m[0]).filter((h) => !PLACEHOLDERS.has(h));
    // Terminal output wraps, so a URL arrives as `claude.ai/code/se` +
    // newline + `ssion_01JLY…`. Matching the raw OCR misses exactly the leak
    // this exists to catch, so whitespace is squeezed out first.
    const squeezed = text.replace(/[\s\u200b]+/g, '');
    const other = FORBIDDEN.map(({ name, re }) => {
        const found = text.match(re) ?? squeezed.match(re);
        return found === null ? undefined : `${name} ${JSON.stringify(found[0].slice(0, 60))}`;
    }).find(Boolean);
    const hit = lower.includes(EXTRA) ? `relay host ${JSON.stringify(EXTRA)}`
        : hosts[0] !== undefined ? `relay host ${JSON.stringify(hosts[0])}`
        : other;
    if (hit !== undefined) {
        console.error(`LEAK ${file}: ${hit}`);
        failures += 1;
    }
}

console.log(failures === 0 ? `ok  ${files.length} frames clean` : `${failures} problem(s)`);
process.exit(failures === 0 ? 0 : 1);
