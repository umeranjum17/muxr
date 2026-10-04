/** `muxr share <path>` — copy a file into this pane's durable Shared Artifacts history. */

import { copyFileSync, linkSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { basename, dirname, extname, join, resolve, sep } from 'node:path';

const IMAGE_TYPES = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' };
/** The phone's preview limit for a page; inlined images count against it. */
const MAX_PAGE_BYTES = 8 * 1024 * 1024;

function fail(message) {
    process.stderr.write(`muxr share: ${message}\n`);
    process.exitCode = 1;
}

function usage() {
    process.stderr.write('usage: muxr share <path> [--title <title>] [--pane <pane-id>]\n\nSave a file to the current pane\'s Shared Artifacts timeline.\nAn .html page is published with its local images inlined; sharing the same\ntitle again adds a new version of that page (--title defaults to the filename).\nWithout --pane, uses HERDR_PANE_ID (set inside every Herdr pane).\n');
}

function parseArgs(args) {
    let path;
    let pane;
    let title;
    for (let index = 0; index < args.length; index += 1) {
        const arg = args[index];
        if (arg === '--help' || arg === '-h') return { help: true };
        if (arg === '--pane') {
            pane = args[++index];
            if (!pane) return { error: '--pane requires a pane id' };
            continue;
        }
        if (arg === '--title') {
            title = args[++index];
            if (!title) return { error: '--title requires a title' };
            continue;
        }
        if (arg.startsWith('-')) return { error: `unknown option: ${arg}` };
        if (path !== undefined) return { error: 'pass exactly one file' };
        path = arg;
    }
    return path === undefined ? { error: 'missing file' } : { path, pane, title };
}

function collisionName(name, suffix) {
    if (suffix === 0) return name;
    const extension = extname(name);
    return `${basename(name, extension)}-${suffix}${extension}`;
}

/**
 * One self-contained page: every <img src> must be a local png/jpeg/webp/gif
 * inside the page's own folder, and is inlined as a data: URI. Remote,
 * absolute and escaping references fail here rather than being fetched later.
 */
function inlinePage(path) {
    const folder = realpathSync(dirname(path));
    return readFileSync(path, 'utf8').replace(/(<img\b[^>]*?\bsrc\s*=\s*)(["'])(.*?)\2/gi, (_match, before, quote, ref) => {
        if (ref.startsWith('data:')) return `${before}${quote}${ref}${quote}`;
        if (/^([a-z][a-z0-9+.-]*:|\/|\\)/i.test(ref)) throw new Error(`image must be a file next to the page: ${ref}`);
        let image;
        try {
            image = realpathSync(resolve(folder, decodeURI(ref.split(/[?#]/)[0])));
        } catch {
            throw new Error(`missing image: ${ref}`);
        }
        const type = IMAGE_TYPES[extname(image).slice(1).toLowerCase()];
        if (!image.startsWith(`${folder}${sep}`)) throw new Error(`image is outside the page's folder: ${ref}`);
        if (type === undefined || !statSync(image).isFile()) throw new Error(`not a png, jpeg, webp or gif image: ${ref}`);
        return `${before}${quote}data:${type};base64,${readFileSync(image).toString('base64')}${quote}`;
    });
}

/** Page versions are `<title>@v<N>.html`; the title is the page's lasting identity. */
function pageTitle(title) {
    return title.trim().replace(/[\u0000-\u001f/\\@]/g, '-').replace(/^\.+/, '').slice(0, 80).trim();
}

function nextVersion(dir, title) {
    let version = 0;
    for (const name of readdirSync(dir)) {
        const match = name.startsWith(`${title}@v`) && /^(\d+)\.html$/.exec(name.slice(title.length + 2));
        if (match) version = Math.max(version, Number(match[1]));
    }
    return version + 1;
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
    const isPage = /\.html?$/i.test(original);
    if (parsed.title !== undefined && !isPage) {
        fail('--title is for .html pages');
        return;
    }
    const title = isPage ? pageTitle(parsed.title ?? basename(original, extname(original))) : '';
    if (isPage && !title) {
        fail('invalid title');
        return;
    }
    let page;
    try {
        page = isPage ? Buffer.from(inlinePage(parsed.path)) : undefined;
    } catch (error) {
        fail(error instanceof Error ? error.message : String(error));
        return;
    }
    if (page !== undefined && page.length > MAX_PAGE_BYTES) {
        fail('page is over 8 MB with its images; use smaller images');
        return;
    }
    const name = original.startsWith('.') ? `shared${original}` : original;
    const temporary = join(dir, `.share-${randomBytes(6).toString('hex')}.tmp`);
    try {
        mkdirSync(dir, { recursive: true });
        if (page === undefined) copyFileSync(parsed.path, temporary);
        else writeFileSync(temporary, page);
        const firstVersion = page === undefined ? 0 : nextVersion(dir, title);
        for (let suffix = 0; ; suffix += 1) {
            const stored = page === undefined ? collisionName(name, suffix) : `${title}@v${firstVersion + suffix}.html`;
            try {
                // The completed temp inode becomes visible in one operation;
                // the watcher can never hash a half-copied artifact.
                linkSync(temporary, join(dir, stored));
                process.stdout.write(page === undefined ? `Shared ${stored}\n` : `Shared ${title} v${firstVersion + suffix}\n`);
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
