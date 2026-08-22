#!/usr/bin/env node
// Records the desk by polling the pane's rendered screen.
//
//   node capture/deskpoll.mjs auth-fix raw/take/desk.cast [--fps 10]
//
// `herdr terminal session observe` is the stream the app's LIVE strip uses and
// it is deliberately frugal: on a hundred-second take it emitted thirty
// repaints and never sent the approval prompt at all. Fine for a thumbnail,
// useless for a recording.
//
// `herdr agent read --source visible` returns the whole rendered screen, and
// costs about two milliseconds, so polling it is cheap and — more importantly —
// complete. Each poll is written as a full-screen repaint: cursor home, clear,
// then the text. That is still the pane's own output, sampled rather than
// streamed; nothing is redrawn or invented.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createWriteStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';

const exec = promisify(execFile);
const [, , target, output, ...rest] = process.argv;
if (!target || !output) {
    console.error('usage: deskpoll.mjs <agent> <out.cast> [--fps N] [--cols N] [--rows N]');
    process.exit(2);
}
const flag = (name, fallback) => {
    const at = rest.indexOf(`--${name}`);
    return at === -1 ? fallback : Number(rest[at + 1]);
};
const fps = flag('fps', 10);
const cols = flag('cols', 60);
const rows = flag('rows', 22);

await mkdir(path.dirname(path.resolve(output)), { recursive: true });
const cast = createWriteStream(output);
cast.write(`${JSON.stringify({
    version: 2, width: cols, height: rows,
    timestamp: Math.floor(Date.now() / 1000),
    env: { SHELL: '/usr/bin/bash', TERM: 'xterm-256color' },
})}\n`);

const started = Date.now();
let frames = 0;
let previous = '';
let stopping = false;

const stop = () => {
    if (stopping) return;
    stopping = true;
    cast.end(() => {
        console.log(`${output} — ${frames} frames, ${((Date.now() - started) / 1000).toFixed(1)}s`);
        process.exit(0);
    });
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);

while (!stopping) {
    const at = Date.now();
    const screen = await exec('herdr', ['agent', 'read', target, '--source', 'visible'], { maxBuffer: 1 << 24 })
        .then((r) => r.stdout)
        .catch(() => undefined);

    // Only write when the screen actually changed: a cast full of identical
    // repaints renders the same but takes far longer to encode.
    if (screen !== undefined && screen !== previous) {
        previous = screen;
        // Home, clear, then the screen. The lines are already wrapped to the
        // pane's width by herdr, so they are emitted as-is.
        const payload = `[H[2J${screen.replace(/\n/g, '\r\n')}`;
        cast.write(`${JSON.stringify([(Date.now() - started) / 1000, 'o', payload])}\n`);
        frames += 1;
    }

    const spent = Date.now() - at;
    const wait = Math.max(0, Math.round(1000 / fps) - spent);
    await new Promise((done) => setTimeout(done, wait));
}
