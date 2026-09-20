/** `muxr share <path>` — copy a file into this pane's durable Shared Artifacts history. */

import { copyFileSync, linkSync, mkdirSync, statSync, unlinkSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { basename, extname, join, resolve, sep } from 'node:path';

function fail(message) {
    process.stderr.write(`muxr share: ${message}\n`);
    process.exitCode = 1;
}

function usage() {
    process.stderr.write('usage: muxr share <path> [--pane <pane-id>]\n\nSave a file to the current pane\'s Shared Artifacts timeline.\nWithout --pane, uses HERDR_PANE_ID (set inside every Herdr pane).\n');
}

function parseArgs(args) {
    let path;
    let pane;
    for (let index = 0; index < args.length; index += 1) {
        const arg = args[index];
        if (arg === '--help' || arg === '-h') return { help: true };
        if (arg === '--pane') {
            pane = args[++index];
            if (!pane) return { error: '--pane requires a pane id' };
            continue;
        }
        if (arg.startsWith('-')) return { error: `unknown option: ${arg}` };
        if (path !== undefined) return { error: 'pass exactly one file' };
        path = arg;
    }
    return path === undefined ? { error: 'missing file' } : { path, pane };
}

function collisionName(name, suffix) {
    if (suffix === 0) return name;
    const extension = extname(name);
    return `${basename(name, extension)}-${suffix}${extension}`;
}

export function share(args = []) {
    process.exitCode = 0;
    const parsed = parseArgs(args);
    if ('help' in parsed) {
        usage();
        return;
    }
    if ('error' in parsed) {
        usage();
        fail(parsed.error);
        return;
    }

    const paneId = parsed.pane || process.env.HERDR_PANE_ID?.trim();
    if (!paneId) {
        fail('no pane: run inside a Herdr pane (HERDR_PANE_ID) or pass --pane <id>');
        return;
    }
    if (paneId === '.' || paneId === '..' || paneId.includes('/') || paneId.includes('\\')) {
        fail('invalid pane');
        return;
    }

    let source;
    try {
        source = statSync(parsed.path);
    } catch {
        fail(`no such file: ${parsed.path}`);
        return;
    }
    if (!source.isFile()) {
        fail(`not a file: ${parsed.path}`);
        return;
    }

    const muxrHome = process.env.MUXR_HOME?.trim() || join(homedir(), '.muxr');
    const root = resolve(muxrHome, 'attachments', 'pane');
    const dir = resolve(root, paneId);
    if (!dir.startsWith(`${root}${sep}`)) {
        fail('invalid pane');
        return;
    }
    const original = basename(parsed.path);
    const name = original.startsWith('.') ? `shared${original}` : original;
    const temporary = join(dir, `.share-${randomBytes(6).toString('hex')}.tmp`);
    try {
        mkdirSync(dir, { recursive: true });
        copyFileSync(parsed.path, temporary);
        for (let suffix = 0; ; suffix += 1) {
            const stored = collisionName(name, suffix);
            try {
                // The completed temp inode becomes visible in one operation;
                // the watcher can never hash a half-copied artifact.
                linkSync(temporary, join(dir, stored));
                process.stdout.write(`Shared ${stored}\n`);
                break;
            } catch (error) {
                if (error?.code === 'EEXIST') continue;
                throw error;
            }
        }
    } catch (error) {
        fail(`could not share the file: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
        try { unlinkSync(temporary); } catch { /* no temp, or already cleaned */ }
    }
}
