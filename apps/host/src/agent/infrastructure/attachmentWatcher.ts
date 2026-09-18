/**
 * Per-pane attachment files. Agents drop artifacts into
 * ~/.muxr/attachments/pane/<HERDR_PANE_ID>/. The attachments plugin lists
 * them; this watcher is the prepare/fetch/read source for download tickets.
 */

import { createHash } from 'node:crypto';
import { createReadStream, mkdirSync, readdirSync, watch, type FSWatcher } from 'node:fs';
import { open as openAsync, readdir, readFile, stat, unlink, writeFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import type { SessionAttachment } from '@muxr/contract';

/** Files named `show-*` in a pane dir are not attachments: they are inline
 *  images pushed by `muxr show-image`, forwarded to live terminal viewers and
 *  deleted -- never listed, never stored. */
export const SHOW_PREFIX = 'show-';

export const MAX_ATTACHMENTS = 50;
// Large images stay metadata-only instead of crossing the relay inline.
export const MAX_INLINE_BYTES = 8 * 1024 * 1024;
/** Whole-file fetch is only the small healing path; larger files use chunks/download. */
export const MAX_FETCH_BYTES = 2 * 1024 * 1024;
// One pane may contain dozens of individually valid previews. Bound every
// event so attachment discovery never starves session/terminal traffic;
// metadata-only entries heal lazily through attachment.fetch when opened.
export const MAX_INITIAL_INLINE_BYTES = 2 * 1024 * 1024;
const DEBOUNCE_MS = 300;
/** Backstop for missed fs.watch events: rescan every pane dir this often. */
const RESCAN_MS = 30_000;

const MIME_BY_EXT: Record<string, string> = {
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    webp: 'image/webp',
    svg: 'image/svg+xml',
    mp4: 'video/mp4',
    mov: 'video/quicktime',
    webm: 'video/webm',
    mkv: 'video/x-matroska',
    pdf: 'application/pdf',
    apk: 'application/vnd.android.package-archive',
    json: 'text/plain',
    txt: 'text/plain',
    md: 'text/plain',
    log: 'text/plain',
};

/** Docs/code the phone previews as text. Anything an agent writes that's
 *  meant to be read -- notes, emails, reports, code -- lands here. */
const TEXT_EXTS = new Set([
    'eml', 'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'py', 'rb', 'go', 'rs',
    'java', 'kt', 'swift', 'c', 'h', 'cpp', 'hpp', 'cs', 'sh', 'bash', 'zsh',
    'yaml', 'yml', 'toml', 'ini', 'cfg', 'conf', 'xml', 'html', 'htm', 'css',
    'scss', 'sql', 'csv', 'tsv', 'env', 'gitignore', 'editorconfig',
]);

/** Text inlines whole (no compression) up to this; bigger stays a named row. */
const MAX_TEXT_BYTES = 256 * 1024;
/** Screen recordings are chunky; 32MiB covers typical clips, base64'd once per id. */
const MAX_VIDEO_BYTES = 32 * 1024 * 1024;

/**
 * Hash a big file without buffering it: reading a 250MB APK at once blocks
 * the event loop for seconds on every rescan, and the buffer itself is dead
 * weight -- such files are never inlined anyway.
 */
function hashFileStream(path: string): Promise<string> {
    return new Promise((resolve, reject) => {
        const hash = createHash('sha256');
        createReadStream(path)
            .on('data', (chunk) => hash.update(chunk))
            .on('end', () => resolve(hash.digest('hex')))
            .on('error', reject);
    });
}

function compareNames(a: string, b: string): number {
    if (a < b) return -1;
    if (a > b) return 1;
    return 0;
}

async function statCandidates(dir: string, names: string[]): Promise<Array<{ name: string; path: string; size: number; at: number; signature: string }>> {
    const found: Array<{ name: string; path: string; size: number; at: number; signature: string }> = [];
    let next = 0;
    const worker = async (): Promise<void> => {
        while (next < names.length) {
            const name = names[next++];
            if (name === undefined) continue;
            try {
                const path = join(dir, name);
                const info = await stat(path);
                if (info.isFile()) found.push({ name, path, size: info.size, at: Math.floor(info.mtimeMs), signature: `${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}` });
            } catch {
                // A file that vanished after readdir is not a scan failure.
            }
        }
    };
    await Promise.all(Array.from({ length: Math.min(32, names.length) }, worker));
    return found;
}

function mimeFor(name: string): string {
    const dot = name.lastIndexOf('.');
    if (dot < 0) return 'application/octet-stream';
    const ext = name.slice(dot + 1).toLowerCase();
    if (TEXT_EXTS.has(ext)) return 'text/plain';
    return MIME_BY_EXT[ext] ?? 'application/octet-stream';
}

/** Magic-byte sniff for show-image pushes; the extension is untrusted. */
function sniffImageMime(bytes: Uint8Array): string | undefined {
    if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png';
    if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
    if (bytes.length >= 6 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return 'image/gif';
    if (bytes.length >= 12
        && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46
        && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return 'image/webp';
    return undefined;
}

/** The host side of `muxr show-image`: returns how many live viewers got the image. */
export type ShowImageSink = (paneId: string, image: { mime: string; bytes: string }) => number | Promise<number>;

/** Metadata-only view of an attachment (id + fields, no base64 data). */
function metaOnly(entry: SessionAttachment): Omit<SessionAttachment, 'data'> {
    return { id: entry.id, name: entry.name, mimeType: entry.mimeType, size: entry.size, at: entry.at };
}

export interface CachedAttachment extends Omit<SessionAttachment, 'data'> {
    /** Cache key from filesystem identity + metadata; a changed file is re-read/re-hashed. */
    signature: string;
}

/**
 * Newest 50 files in rootDir/paneId, files only. Every entry carries a sha256
 * content hash as its id; small previews are inlined as base64. Never throws:
 * a missing or half-written pane scans as whatever is readable.
 */
export interface AttachmentScan {
    attachments: SessionAttachment[];
    total: number;
    truncated: boolean;
}

export async function scanPaneWithAttribution(rootDir: string, paneId: string, cache?: Map<string, CachedAttachment>): Promise<AttachmentScan> {
    const root = resolve(rootDir);
    const dir = resolve(root, paneId);
    if (!dir.startsWith(`${root}${sep}`)) return { attachments: [], total: 0, truncated: false };
    let entries: import('node:fs').Dirent[];
    try {
        entries = await readdir(dir, { withFileTypes: true });
    } catch {
        return { attachments: [], total: 0, truncated: false };
    }
    const names = entries
        .filter((entry) => entry.isFile() && !entry.name.startsWith('.') && !entry.name.startsWith(SHOW_PREFIX))
        .map((entry) => entry.name)
        .sort(compareNames);
    const total = names.length;
    // Stat work is asynchronous and concurrency-bounded; inspecting every
    // name is required to select the actual newest 50 rather than a stale
    // alphabetical sample when a pane contains thousands of artifacts.
    const candidates = (await statCandidates(dir, names))
        .sort((a, b) => b.at - a.at || compareNames(a.name, b.name));
    const out: SessionAttachment[] = [];
    for (const candidate of candidates.slice(0, MAX_ATTACHMENTS)) {
        const { name, path, size, at, signature } = candidate;
        try {
            const mimeType = mimeFor(name);
            const cached = cache?.get(name);
            if (cached?.signature === signature) {
                const { signature: _signature, ...entry } = cached;
                out.push(entry);
                continue;
            }
            const entry: SessionAttachment = { id: '', name, mimeType, size, at };
            if (size > MAX_FETCH_BYTES) {
                // Larger files cannot use the whole-file heal path and the
                // first event's aggregate inline budget would strip them
                // anyway. Stream only the hash; download/read stays chunked.
                entry.id = await hashFileStream(path);
                cache?.set(name, { ...metaOnly(entry), signature });
                out.push(entry);
                continue;
            }
            const content = await readFile(path);
            entry.id = createHash('sha256').update(content).digest('hex');
            const wire = content;
            const isText = mimeType.startsWith('text/');
            const isImage = entry.mimeType.startsWith('image/');
            const isVideo = mimeType.startsWith('video/');
            const isPdf = mimeType === 'application/pdf';
            // Text rides whole (empty files too: a real attachment with nothing
            // in it, rendered as an empty state on the phone); images ride
            // raw; videos and PDFs inline up to their own caps; anything
            // bigger stays a named row.
            if (isText && wire.length <= MAX_TEXT_BYTES) {
                entry.data = wire.toString('base64');
            } else if (isImage && wire.length > 0 && wire.length <= MAX_INLINE_BYTES) {
                entry.data = wire.toString('base64');
            } else if (isVideo && wire.length > 0 && wire.length <= MAX_VIDEO_BYTES) {
                entry.data = wire.toString('base64');
            } else if (isPdf && wire.length > 0 && wire.length <= MAX_INLINE_BYTES) {
                entry.data = wire.toString('base64');
            }
            cache?.set(name, { ...metaOnly(entry), signature });
            out.push(entry);
        } catch {
            // file vanished mid-copy: skip it, never throw into the caller.
        }
    }
    out.sort((a, b) => b.at - a.at);
    return {
        attachments: out.slice(0, MAX_ATTACHMENTS),
        total,
        truncated: total > MAX_ATTACHMENTS,
    };
}

/** Backward-compatible array helper used by callers that do not need attribution. */
export async function scanPane(rootDir: string, paneId: string, cache?: Map<string, CachedAttachment>): Promise<SessionAttachment[]> {
    return (await scanPaneWithAttribution(rootDir, paneId, cache)).attachments;
}

/**
 * Watches the attachments root and re-scans a pane when its signature changes.
 */
export class AttachmentWatcher {
    private readonly lastSignature = new Map<string, string>();
    /** Attachment ids already announced per pane; later lists carry them metadata-only. */
    private readonly emittedIds = new Map<string, Set<string>>();
    private readonly fileCache = new Map<string, Map<string, CachedAttachment>>();
    private readonly scans = new Map<string, Promise<AttachmentScan>>();
    private readonly debounces = new Map<string, ReturnType<typeof setTimeout>>();
    private watcher: FSWatcher | undefined;
    private interval: ReturnType<typeof setInterval> | undefined;

    /** Where `show-*` images go (TerminalManager). Set by the host after wiring; absent, files wait for the next scan. */
    showImage?: ShowImageSink;

    constructor(
        private readonly rootDir: string,
        private readonly emit: (paneId: string, attachments: SessionAttachment[], total?: number, truncated?: boolean) => void,
        private readonly rescanMs: number = RESCAN_MS,
    ) {}

    start(): void {
        try {
            mkdirSync(this.rootDir, { recursive: true });
        } catch {
            // Unwritable root: the watcher below will also fail; stay quiet.
        }
        try {
            this.watcher = watch(this.rootDir, { recursive: true }, (_event, filename) => {
                // recursive watch reports paths relative to rootDir: <paneId>/...
                const paneId = typeof filename === 'string' ? filename.split(/[\\/]/)[0] : undefined;
                if (paneId === undefined || paneId === '') return;
                const pending = this.debounces.get(paneId);
                if (pending !== undefined) clearTimeout(pending);
                this.debounces.set(
                    paneId,
                    setTimeout(() => {
                        this.debounces.delete(paneId);
                        void this.scanAndEmit(paneId);
                    }, DEBOUNCE_MS),
                );
            });
        } catch {
            this.watcher = undefined;
        }
        // Self-healing backstop: Linux fs.watch can miss events, so re-scan
        // every pane dir currently present. Signature-guarded: silent when
        // nothing changed. unref: never keep the process alive just for this.
        this.interval = setInterval(() => void this.rescanAll(), this.rescanMs);
        this.interval.unref();
    }

    /** Re-emit all panes, or only the supplied active panes, even when unchanged. */
    async resendAll(paneIds?: Iterable<string>): Promise<void> {
        if (paneIds === undefined) {
            this.lastSignature.clear();
            await this.rescanAll();
            return;
        }
        for (const paneId of paneIds) {
            this.lastSignature.delete(paneId);
            await this.scanAndEmit(paneId);
        }
    }

    /** Backstop for missed fs.watch events: re-scan every pane dir under rootDir now. */
    async rescanAll(): Promise<void> {
        let names: string[];
        try {
            names = readdirSync(this.rootDir, { withFileTypes: true })
                .filter((entry) => entry.isDirectory())
                .map((entry) => entry.name);
        } catch {
            return; // root missing/unreadable: nothing to rescan.
        }
        // Two panes may scan concurrently, and a fast pane releases its slot
        // immediately instead of waiting behind a huge sibling in its batch.
        let next = 0;
        const worker = async (): Promise<void> => {
            while (next < names.length) {
                const paneId = names[next++];
                if (paneId !== undefined) await this.scanAndEmit(paneId);
            }
        };
        await Promise.all(Array.from({ length: Math.min(2, names.length) }, worker));
    }

    private async scanAndEmit(paneId: string): Promise<void> {
        try {
            await this.forwardShowImages(paneId);
            const cache = this.fileCache.get(paneId) ?? new Map<string, CachedAttachment>();
            this.fileCache.set(paneId, cache);
            const scan = await this.scan(paneId, cache);
            const attachments = scan.attachments;
            const names = new Set(attachments.map((entry) => entry.name));
            for (const name of cache.keys()) if (!names.has(name)) cache.delete(name);
            // Signature over the METADATA-ONLY view: stripping data on the
            // second emit must not look like a change.
            const signature = JSON.stringify({ attachments: attachments.map(metaOnly), total: scan.total, truncated: scan.truncated });
            if (this.lastSignature.get(paneId) === signature) return;
            this.lastSignature.set(paneId, signature);
            const known = this.emittedIds.get(paneId);
            let inlineBytes = 0;
            const wireView = attachments.map((entry) => {
                if (known?.has(entry.id) || entry.data === undefined) return metaOnly(entry);
                const bytes = Buffer.byteLength(entry.data);
                if (inlineBytes + bytes > MAX_INITIAL_INLINE_BYTES) return metaOnly(entry);
                inlineBytes += bytes;
                return entry;
            });
            this.emittedIds.set(
                paneId,
                new Set(attachments.map((entry) => entry.id)),
            );
            this.emit(paneId, wireView, scan.total, scan.truncated);
        } catch {
            // Never throw into the watch callback.
        }
    }

    /** Reuse the metadata/hash cache for download ticket preparation. */
    cacheFor(paneId: string): Map<string, CachedAttachment> {
        const cache = this.fileCache.get(paneId) ?? new Map<string, CachedAttachment>();
        this.fileCache.set(paneId, cache);
        return cache;
    }

    /**
     * Forward every `show-*` file in the pane dir to live terminal viewers,
     * then delete it: the phone renders the bytes from the frame alone, so no
     * copy survives on either side. A `.show-<name>.rc` receipt tells the CLI
     * how many viewers saw it (dot-prefixed, so the listing filter never
     * shows it).
     */
    private async forwardShowImages(paneId: string): Promise<void> {
        if (this.showImage === undefined) return;
        const dir = join(resolve(this.rootDir), paneId);
        let names: string[];
        try {
            names = (await readdir(dir, { withFileTypes: true }))
                .filter((entry) => entry.isFile() && entry.name.startsWith(SHOW_PREFIX))
                .map((entry) => entry.name);
        } catch {
            return; // No pane dir (or unreadable): nothing to forward.
        }
        for (const name of names) {
            const path = join(dir, name);
            try {
                const content = await readFile(path);
                const mime = content.length > 0 && content.length <= MAX_INLINE_BYTES ? sniffImageMime(content) : undefined;
                if (mime === undefined) {
                    await unlink(path);
                    process.stderr.write(`show-image: ${name} in pane ${paneId} is not a supported image (png, jpeg, gif, webp, <=8MB); discarded\n`);
                    continue;
                }
                const viewers = await this.showImage(paneId, { mime, bytes: content.toString('base64') });
                try {
                    await writeFile(join(dir, `.${name}.rc`), JSON.stringify({ viewers }));
                } catch {
                    // A receipt the CLI never reads is a cosmetic loss, not a delivery one.
                }
                await unlink(path);
            } catch (error) {
                // Sink threw (e.g. mid-startup wiring): leave the file for the
                // next scan instead of dropping the captain's image.
                process.stderr.write(`show-image: could not forward ${name} for pane ${paneId}: ${error instanceof Error ? error.message : String(error)}\n`);
            }
        }
    }

    /** Clear per-pane state (debounce + last signature + emitted ids). Does NOT delete files. */
    dropPane(paneId: string): void {
        const pending = this.debounces.get(paneId);
        if (pending !== undefined) clearTimeout(pending);
        this.debounces.delete(paneId);
        this.lastSignature.delete(paneId);
        this.emittedIds.delete(paneId);
        this.fileCache.delete(paneId);
        this.scans.delete(paneId);
    }

    async scanPane(paneId: string): Promise<AttachmentScan> {
        const cache = this.fileCache.get(paneId) ?? new Map<string, CachedAttachment>();
        this.fileCache.set(paneId, cache);
        return this.scan(paneId, cache);
    }

    private scan(paneId: string, cache: Map<string, CachedAttachment>): Promise<AttachmentScan> {
        const existing = this.scans.get(paneId);
        if (existing !== undefined) return existing;
        const scan = scanPaneWithAttribution(this.rootDir, paneId, cache).finally(() => {
            if (this.scans.get(paneId) === scan) this.scans.delete(paneId);
        });
        this.scans.set(paneId, scan);
        return scan;
    }

    /**
     * One attachment's full entry (with data) by content-hash id. Clients that
     * missed the one-time data emit heal through this. Anything over the
     * inline caps is answered null -- big files download over HTTP.
     */
    async fetch(paneId: string, attachmentId: string): Promise<SessionAttachment | null> {
        const cache = this.fileCache.get(paneId) ?? new Map<string, CachedAttachment>();
        this.fileCache.set(paneId, cache);
        const scan = await this.scan(paneId, cache);
        const found = scan.attachments.find((entry) => entry.id === attachmentId);
        if (found === undefined) return null;
        if (found.size > MAX_FETCH_BYTES) return null;
        if (found.data !== undefined) return found;
        try {
            // Check size BEFORE reading: reading+base64+JSON-stringifying a
            // 250MB file OOM-crashed the host in production. Big files use the
            // bounded attachment.read chunks below.
            const info = await stat(join(this.rootDir, paneId, found.name));
            if (info.size === 0 || info.size > MAX_FETCH_BYTES) return null;
            const data = await readFile(join(this.rootDir, paneId, found.name));
            if (createHash('sha256').update(data).digest('hex') !== attachmentId) return null;
            return { ...found, data: data.toString('base64') };
        } catch {
            return null;
        }
    }

    /** Bounded read for large hosted attachments; the RPC envelope encrypts every chunk. */
    async read(paneId: string, attachmentId: string, offset: number, length: number): Promise<{
        id: string; name: string; mimeType: string; size: number; offset: number; data: string;
    } | null> {
        if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 1 || length > 512 * 1024) {
            throw new Error('attachment.read: invalid range');
        }
        const cache = this.fileCache.get(paneId) ?? new Map<string, CachedAttachment>();
        this.fileCache.set(paneId, cache);
        const found = (await this.scan(paneId, cache)).attachments.find(
            (entry) => entry.id === attachmentId || entry.name === attachmentId,
        );
        if (found === undefined || offset >= found.size) return null;
        const path = join(this.rootDir, paneId, found.name);
        const bytes = Buffer.alloc(Math.min(length, found.size - offset));
        let descriptor: Awaited<ReturnType<typeof openAsync>> | undefined;
        try {
            descriptor = await openAsync(path, 'r');
            const { bytesRead } = await descriptor.read(bytes, 0, bytes.length, offset);
            return { id: found.id, name: found.name, mimeType: found.mimeType, size: found.size, offset, data: bytes.subarray(0, bytesRead).toString('base64') };
        } catch {
            return null;
        } finally {
            await descriptor?.close().catch(() => undefined);
        }
    }

    dispose(): void {
        if (this.interval !== undefined) {
            clearInterval(this.interval);
            this.interval = undefined;
        }
        for (const pending of this.debounces.values()) clearTimeout(pending);
        this.debounces.clear();
        this.lastSignature.clear();
        this.emittedIds.clear();
        this.fileCache.clear();
        this.scans.clear();
        this.watcher?.close();
        this.watcher = undefined;
    }
}
