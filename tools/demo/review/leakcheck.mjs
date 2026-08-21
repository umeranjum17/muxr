#!/usr/bin/env node
// Fails if a shipped frame contains the machine owner's relay host.
//
//   node review/leakcheck.mjs review/reel/*.png review/frames/*.png
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

const exec = promisify(execFile);

/** The placeholder a masked capture is allowed to show. */
// Matched on the tail, because OCR routinely drops the leading label: the
// placeholder reads as 'host.ts.net' about as often as 'your-host.ts.net'.
const PLACEHOLDER = 'host.ts.net';
/**
 * Any tailnet-looking host that is not the placeholder. Matching a bare
 * `.ts.net` flags the placeholder itself, which is the one string that is
 * meant to be there.
 */
const HOSTS = /\b([a-z0-9-]+\.)?[a-z0-9-]*\.ts\.net\b/gi;
const EXTRA = (process.env.MUXR_RELAY_HOST?.trim() || 'tail0de54').toLowerCase();

const files = process.argv.slice(2);
if (files.length === 0) {
    console.error('usage: leakcheck.mjs <image>...');
    process.exit(2);
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
    const hosts = [...lower.matchAll(HOSTS)].map((m) => m[0]).filter((h) => !h.includes(PLACEHOLDER));
    const hit = lower.includes(EXTRA) ? EXTRA : hosts[0];
    if (hit !== undefined) {
        console.error(`LEAK ${file}: contains ${JSON.stringify(hit)}`);
        failures += 1;
    }
}

console.log(failures === 0 ? `ok  ${files.length} frames carry no relay host` : `${failures} problem(s)`);
process.exit(failures === 0 ? 0 : 1);
