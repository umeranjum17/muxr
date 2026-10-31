import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readdirSync, readSync, realpathSync, rmSync, statSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { MOVE_CHUNK_BYTES, MOVE_MAX_BYTES } from '@trymuxr/contract';
import { moveError } from '../domain/adapters.js';

const STALE_MS = 60 * 60 * 1000;
const ID = /^[0-9a-f]{24}$/;

/** Private bundle files for in-flight moves, under the host's own home. Nothing here outlives an hour. */
export class TransferStore {
    constructor(private readonly home: string) {}

    private dir(): string {
        const dir = join(this.home, 'moves');
        mkdirSync(dir, { recursive: true, mode: 0o700 });
        chmodSync(dir, 0o700);
        return realpathSync(dir);
    }

    private sweep(dir: string): void {
        for (const name of readdirSync(dir)) {
            try { if (Date.now() - statSync(join(dir, name)).mtimeMs > STALE_MS) rmSync(join(dir, name), { force: true }); }
            catch { /* already gone */ }
        }
    }

    /** A fresh export target on the source. */
    newExport(): { id: string; path: string } {
        const dir = this.dir();
        this.sweep(dir);
        const id = randomBytes(12).toString('hex');
        return { id, path: join(dir, `src-${id}.bundle`) };
    }

    private path(id: string, side: 'src' | 'dst'): string {
        if (!ID.test(id)) throw moveError('move-corrupt', 'That move is not recognised. Start it again.');
        return join(this.dir(), `${side}-${id}.bundle`);
    }

    sourceSize(id: string): number {
        const path = this.path(id, 'src');
        if (!existsSync(path)) throw moveError('move-corrupt', 'The exported conversation is gone. Start the move again.');
        return statSync(path).size;
    }

    read(id: string, offset: number, length: number): { offset: number; data: string; eof: boolean } {
        const size = this.sourceSize(id);
        if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 1 || length > MOVE_CHUNK_BYTES) {
            throw moveError('move-corrupt', 'The move asked for an invalid piece. Start it again.');
        }
        const fd = openSync(this.path(id, 'src'), 'r');
        try {
            const buffer = Buffer.alloc(Math.max(0, Math.min(length, size - offset)));
            if (buffer.length > 0) readSync(fd, buffer, 0, buffer.length, offset);
            return { offset, data: buffer.toString('base64'), eof: offset + buffer.length >= size };
        } finally { closeSync(fd); }
    }

    /** Append at exactly the end; a repeat of an earlier offset answers what is held, so a retry is safe. */
    stage(id: string, offset: number, data: string): number {
        const dir = this.dir();
        this.sweep(dir);
        const path = this.path(id, 'dst');
        const held = existsSync(path) ? statSync(path).size : 0;
        if (offset < held) return held;
        if (offset > held) throw moveError('move-corrupt', 'A piece of the conversation went missing on the way. Start the move again.');
        const bytes = Buffer.from(data, 'base64');
        if (held + bytes.length > MOVE_MAX_BYTES) throw moveError('move-too-large', 'This conversation is too long to move. Use Continue instead.');
        const fd = openSync(path, 'a', 0o600);
        try { writeSync(fd, bytes); } finally { closeSync(fd); }
        return held + bytes.length;
    }

    staged(id: string): { path: string; bytes: number; digest: string } {
        const path = this.path(id, 'dst');
        if (!existsSync(path)) throw moveError('move-corrupt', 'Nothing arrived on this computer. Start the move again.');
        const hash = createHash('sha256');
        const fd = openSync(path, 'r');
        const buffer = Buffer.alloc(64 * 1024);
        let bytes = 0;
        try {
            for (let n = readSync(fd, buffer, 0, buffer.length, bytes); n > 0; n = readSync(fd, buffer, 0, buffer.length, bytes)) {
                hash.update(buffer.subarray(0, n));
                bytes += n;
            }
        } finally { closeSync(fd); }
        return { path, bytes, digest: hash.digest('hex') };
    }

    release(id: string): void {
        if (!ID.test(id)) return;
        const dir = this.dir();
        for (const side of ['src', 'dst']) rmSync(join(dir, `${side}-${id}.bundle`), { force: true });
    }
}
