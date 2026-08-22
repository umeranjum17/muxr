#!/usr/bin/env node
// Taps a control on the phone by what it is, not where it was last time.
//
//   node capture/tap.mjs "Enter"
//   node capture/tap.mjs "Up arrow"
//
// The terminal key row scrolls horizontally and does not return to a fixed
// position, so a hard-coded coordinate drifts onto a neighbouring key. That is
// not theoretical: a tap meant for `Enter` landed on `Up arrow` and walked the
// agent's selection from "Yes" down to "No" three takes running.
//
// So the view hierarchy is dumped and the button is found by its
// content-description, which is stable, and its bounds give the centre.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);
/**
 * `--print` resolves the control and reports its centre without tapping.
 *
 * `uiautomator dump` competes with `adb screenrecord` for the device and is
 * killed mid-take, so the position is resolved once before the recorder starts
 * and the take then taps that coordinate. Nothing scrolls the row during a
 * take, so the coordinate stays good.
 */
const printOnly = process.argv.includes('--print');
const label = process.argv[2];
if (!label) {
    console.error('usage: tap.mjs <content-description>');
    process.exit(2);
}

const adb = (args) => exec('adb', args, { maxBuffer: 1 << 26 });

async function find() {
    await adb(['shell', 'uiautomator', 'dump', '/sdcard/ui.xml']);
    const { stdout } = await adb(['shell', 'cat', '/sdcard/ui.xml']);
    return stdout.split('>').find((node) =>
        node.includes(`content-desc="${label}"`) && node.includes('clickable="true"'));
}

/**
 * The key row scrolls horizontally and only renders what is in view, so a key
 * that is off to one side is absent from the hierarchy entirely — not merely
 * at unexpected coordinates. Nudge the row along and look again.
 *
 * The swipe stays well inside the screen: starting near the left edge is read
 * as Android's back gesture and leaves the session.
 */
/** Where the scrolling row actually sits, from whatever of it is on screen. */
async function rowY() {
    await adb(['shell', 'uiautomator', 'dump', '/sdcard/ui.xml']);
    const { stdout } = await adb(['shell', 'cat', '/sdcard/ui.xml']);
    const ys = [...stdout.matchAll(/clickable="true"[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/g)]
        .map((m) => [Number(m[2]), Number(m[4])])
        .filter(([top, bottom]) => bottom - top > 60 && bottom - top < 160 && top > 1700 && bottom < 2300);
    if (ys.length === 0) return 2112;
    // The row is the band with the most controls in it.
    const band = ys.sort((a, b) => a[0] - b[0])[Math.floor(ys.length / 2)];
    return Math.round((band[0] + band[1]) / 2);
}

let wanted = await find();
for (let attempt = 0; wanted === undefined && attempt < 6; attempt += 1) {
    const y = await rowY();
    const [from, to] = attempt % 2 === 0 ? [900, 300] : [300, 900];
    await adb(['shell', 'input', 'swipe', String(from), String(y), String(to), String(y), '400']);
    await new Promise((done) => setTimeout(done, 800));
    wanted = await find();
}
if (wanted === undefined) {
    console.error(`no clickable control described as ${JSON.stringify(label)} after scrolling the row`);
    process.exit(1);
}

const bounds = wanted.match(/bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/);
if (bounds === null) {
    console.error(`found ${JSON.stringify(label)} but it has no bounds`);
    process.exit(1);
}
const [, x1, y1, x2, y2] = bounds.map(Number);
const x = Math.round((x1 + x2) / 2);
const y = Math.round((y1 + y2) / 2);

if (printOnly) {
    console.log(`${x} ${y}`);
} else {
    await adb(['shell', 'input', 'tap', String(x), String(y)]);
    console.log(`tapped ${label} at ${x},${y}`);
}
