/**
 * `muxr show-image <path>` — push a local image straight into the phone's
 * terminal view for the current pane.
 *
 * Mechanics: drop the file into the pane's watched attachments dir under a
 * reserved `show-` name. The host's watcher forwards it to every live terminal
 * viewer as a `terminal.image` frame, writes a `.show-<name>.rc` receipt with
 * the viewer count, and deletes the file — nothing persists anywhere. This
 * command polls for that receipt so the calling agent learns whether anyone
 * actually saw the image.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';

const MIME_BY_EXT = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' };
const MAX_BYTES = 8 * 1024 * 1024;
const RECEIPT_TIMEOUT_MS = 5_000;
const RECEIPT_POLL_MS = 150;

function fail(message) {
    process.stderr.write(`muxr show-image: ${message}\n`);
    process.exitCode = 1;
}

export function showImage(args = []) {
    const pathArg = args.find((arg) => !arg.startsWith('-'));
    const paneIndex = args.indexOf('--pane');
    const pane = paneIndex >= 0 ? args[paneIndex + 1] : undefined;
    if (pathArg === undefined || (paneIndex >= 0 && pane === undefined) || args.some((arg) => arg === '--help' || arg === '-h')) {
        process.stderr.write('usage: muxr show-image <path> [--pane <pane-id>]\n\nRender an image inline in the phone terminal view for the current pane.\nWithout --pane, uses HERDR_PANE_ID (set inside every Herdr pane).\nSupported: png, jpeg, gif, webp, up to 8MB.\n');
        process.exitCode = pathArg === undefined || pane === undefined ? 1 : 0;
        return;
    }

    const paneId = pane || process.env.HERDR_PANE_ID?.trim();
    if (!paneId) {
        fail('no pane: run inside a Herdr pane (HERDR_PANE_ID) or pass --pane <id>');
        return;
    }

    let source;
    try {
        source = statSync(pathArg);
    } catch {
        fail(`no such file: ${pathArg}`);
        return;
    }
    if (!source.isFile()) {
        fail(`not a file: ${pathArg}`);
        return;
    }
    if (source.size > MAX_BYTES) {
        fail(`${pathArg} is ${(source.size / 1024 / 1024).toFixed(1)}MB; the limit is 8MB`);
        return;
    }
    const ext = pathArg.slice(pathArg.lastIndexOf('.') + 1).toLowerCase();
    const mime = MIME_BY_EXT[ext];
    if (!mime) {
        fail(`unsupported image type ".${ext}" (png, jpeg, gif, webp only)`);
        return;
    }

    // Atomic drop: the dot-prefixed temp never shows up in any scan; the
    // rename is the publish moment the host's watcher reacts to.
    const muxrHome = process.env.MUXR_HOME?.trim() || join(homedir(), '.muxr');
    const dir = join(muxrHome, 'attachments', 'pane', paneId);
    const name = `show-${Date.now().toString(36)}-${randomBytes(4).toString('hex')}.${ext}`;
    try {
        mkdirSync(dir, { recursive: true });
        const tmp = join(dir, `.${name}.tmp`);
        writeFileSync(tmp, readFileSync(pathArg));
        renameSync(tmp, join(dir, name));
    } catch (error) {
        fail(`could not stage the image: ${error instanceof Error ? error.message : String(error)}`);
        return;
    }

    const receipt = join(dir, `.${name}.rc`);
    for (let waited = 0; waited <= RECEIPT_TIMEOUT_MS; waited += RECEIPT_POLL_MS) {
        if (existsSync(receipt)) {
            let viewers = 0;
            try {
                viewers = JSON.parse(readFileSync(receipt, 'utf8')).viewers ?? 0;
            } catch { viewers = 0; }
            try { unlinkSync(receipt); } catch { /* receipt cleanup is best-effort */ }
            if (viewers > 0) {
                process.stdout.write(`shown to ${viewers} viewer${viewers === 1 ? '' : 's'}\n`);
            } else {
                fail('no phone is viewing this pane; nothing was shown');
            }
            return;
        }
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, RECEIPT_POLL_MS);
    }
    fail('the muxr host did not pick up the image (is the host daemon running?); it will be shown if a viewer opens soon');
}
