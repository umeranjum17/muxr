/**
 * One-time download tickets for pane attachments, served over plain HTTP.
 *
 * Big files (APKs, screen recordings) must never ride the ws/JSON link: a
 * 250MB file is a ~330MB base64 string that gets stringified, escaped, and
 * copied half a dozen times until something runs out of memory. This server
 * streams the original bytes from disk instead. The relay asks for a ticket
 * over the existing request path, then pipes bytes from here to the phone.
 *
 * URLs are unguessable one-time capabilities (16 random bytes, 5min TTL) --
 * no auth header, because anchor downloads can't set any.
 */

import { createServer, type Server } from 'node:http';
import { createReadStream } from 'node:fs';
import { statSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join, normalize, sep } from 'node:path';
import { scanPane, type AttachmentWatcher } from './attachmentWatcher.js';

const TICKET_TTL_MS = 5 * 60_000;

interface Ticket {
    path: string;
    name: string;
    mimeType: string;
    size: number;
    expiresAt: number;
}

export class AttachmentDownloadServer {
    private readonly tickets = new Map<string, Ticket>();
    private server: Server | undefined;

    constructor(
        private readonly rootDir: string,
        private readonly port: number,
        private readonly watcher?: AttachmentWatcher,
    ) {}

    /** Mint a one-time ticket for an attachment id. null: unknown id. */
    async prepare(paneId: string, attachmentId: string): Promise<{ token: string; name: string; mimeType: string; size: number } | null> {
        const attachments = this.watcher !== undefined
            ? (await this.watcher.scanPane(paneId)).attachments
            : await scanPane(this.rootDir, paneId);
        const found = attachments.find((entry) => entry.id === attachmentId || entry.name === attachmentId);
        if (found === undefined) return null;
        // The ORIGINAL file on disk (scanPane renames compressed images to
        // .webp for the wire; a download deserves the pristine bytes).
        const realPath = this.originalPath(paneId, found);
        const name = realPath.slice(realPath.lastIndexOf('/') + 1);
        const token = randomBytes(16).toString('hex');
        this.tickets.set(token, {
            path: realPath,
            name,
            mimeType: found.mimeType,
            size: found.size,
            expiresAt: Date.now() + TICKET_TTL_MS,
        });
        console.log(`[attachment-download] ticket minted name=${name} size=${found.size}`);
        return { token, name, mimeType: found.mimeType, size: found.size };
    }

    /** A compressed image's wire name is x.webp but the disk file is x.png/jpg. */
    private originalPath(paneId: string, entry: { name: string }): string {
        if (entry.name.endsWith('.webp')) {
            const base = entry.name.slice(0, -'.webp'.length);
            for (const ext of ['png', 'jpg', 'jpeg']) {
                const candidate = join(this.rootDir, paneId, `${base}.${ext}`);
                try {
                    if (statSync(candidate).isFile()) return candidate;
                } catch {
                    // try next
                }
            }
        }
        return join(this.rootDir, paneId, entry.name);
    }

    start(): void {
        this.server = createServer((req, res) => {
            let token;
            try { token = decodeURIComponent(req.url ?? '').replace(/^\/attachment\//, ''); }
            catch {
                res.writeHead(400).end('bad request');
                return;
            }
            const ticket = this.tickets.get(token);
            if (ticket === undefined || ticket.expiresAt < Date.now()) {
                this.tickets.delete(token);
                res.writeHead(404).end('unknown or expired ticket');
                return;
            }
            this.tickets.delete(token); // one-time
            const normalized = normalize(ticket.path);
            const root = normalize(this.rootDir);
            const rootPrefix = root.endsWith(sep) ? root : `${root}${sep}`;
            if (!normalized.startsWith(rootPrefix)) {
                res.writeHead(403).end('bad path');
                return;
            }
            let size = ticket.size;
            try {
                size = statSync(normalized).size;
            } catch {
                res.writeHead(404).end('file gone');
                return;
            }
            console.log(`[attachment-download] serve ${ticket.name} (${size}B) range=${req.headers.range ?? 'none'}`);
            let sent = 0;
            res.on('finish', () => console.log(`[attachment-download] serve done ${ticket.name} bytes=${sent}`));
            res.on('close', () => console.log(`[attachment-download] serve closed early ${ticket.name} bytes=${sent}/${size}`));
            const headers: Record<string, string | number> = {
            'content-type': ticket.mimeType === 'application/vnd.android.package-archive'
                ? 'application/octet-stream'
                : ticket.mimeType,
                'accept-ranges': 'bytes',
                'content-disposition': `attachment; filename="${ticket.name.replace(/[^A-Za-z0-9._-]/g, '_')}"`,
            };
            // Chrome parallel-chunks and resumes big downloads with Range
            // requests; a 250MB file over mobile data does not survive without
            // them. Honor a single byte range with a proper 206.
            const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? '');
            if (range !== null) {
                const start = range[1] === '' ? Math.max(0, size - Number(range[2])) : Number(range[1]);
                const end = range[2] === '' || range[1] === '' ? size - 1 : Math.min(Number(range[2]), size - 1);
                if (start >= size || start > end) {
                    res.writeHead(416, { 'content-range': `bytes */${size}` }).end();
                    return;
                }
                res.writeHead(206, {
                    ...headers,
                    'content-range': `bytes ${start}-${end}/${size}`,
                    'content-length': end - start + 1,
                });
                createReadStream(normalized, { start, end }).on('data', (chunk) => { sent += chunk.length; }).pipe(res);
                return;
            }
            res.writeHead(200, { ...headers, 'content-length': size });
            createReadStream(normalized).on('data', (chunk) => { sent += chunk.length; }).pipe(res);
        });
        // Loopback only: the relay pipes from here, nothing else may reach it.
        this.server.on('error', () => {
            // A busy port (old host instance, stray test server) must never
            // take the whole host down; downloads degrade, everything else works.
            this.server = undefined;
        });
        this.server.listen(this.port, '127.0.0.1');
    }

    dispose(): void {
        this.server?.close();
        this.tickets.clear();
    }
}
