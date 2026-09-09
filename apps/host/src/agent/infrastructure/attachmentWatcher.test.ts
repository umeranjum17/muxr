import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { SessionAttachment } from '@muxr/contract';
import { AttachmentWatcher, MAX_INITIAL_INLINE_BYTES, MAX_INLINE_BYTES, scanPane, scanPaneWithAttribution } from './attachmentWatcher.js';

const PIXEL_B64 =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
const PIXEL = Buffer.from(PIXEL_B64, 'base64');

const roots: string[] = [];
function paneRoot(): string {
    const root = mkdtempSync(join(tmpdir(), 'muxr-attachments-'));
    roots.push(root);
    return root;
}
afterAll(() => roots.forEach((root) => rmSync(root, { recursive: true, force: true })));

describe('scanPane', () => {
    it('returns files with mime types and inline base64 for small images', async () => {
        const root = paneRoot();
        mkdirSync(join(root, 'p1'), { recursive: true });
        writeFileSync(join(root, 'p1', 'shot.png'), Buffer.from(PIXEL_B64, 'base64'));
        writeFileSync(join(root, 'p1', 'notes.md'), 'hello\n');
        writeFileSync(join(root, 'p1', 'clip.mp4'), 'not really mp4');
        writeFileSync(join(root, 'p1', 'blob.bin'), 'x');
        // Subdirs are skipped, not scanned.
        mkdirSync(join(root, 'p1', 'sub'), { recursive: true });
        writeFileSync(join(root, 'p1', 'sub', 'nested.png'), Buffer.from(PIXEL_B64, 'base64'));

        const entries = await scanPane(root, 'p1');
        expect(entries).toHaveLength(4);
        const byName = new Map(entries.map((entry) => [entry.name, entry]));
        expect(byName.get('shot.png')!).toMatchObject({
            mimeType: 'image/png',
            size: Buffer.from(PIXEL_B64, 'base64').length,
            data: PIXEL_B64,
        });
        expect(byName.get('shot.png')!.id).toBe(createHash('sha256').update(PIXEL).digest('hex'));
        for (const entry of entries) expect(entry.id).toMatch(/^[0-9a-f]{64}$/);
        expect(byName.get('notes.md')!).toMatchObject({ mimeType: 'text/plain' });
        expect(byName.get('clip.mp4')!).toMatchObject({ mimeType: 'video/mp4' });
        expect(byName.get('blob.bin')!).toMatchObject({ mimeType: 'application/octet-stream' });
        for (const entry of entries) expect(entry.at).toEqual(expect.any(Number));
    });

    it('does not inline an uncompressible image over the wire cap', async () => {
        const root = paneRoot();
        mkdirSync(join(root, 'p1'), { recursive: true });
        const big = Buffer.alloc(MAX_INLINE_BYTES + 17, 1);
        writeFileSync(join(root, 'p1', 'big.png'), big);

        const [entry] = await scanPane(root, 'p1');
        expect(entry!.name).toBe('big.png');
        expect(entry!.mimeType).toBe('image/png');
        expect(entry!.size).toBe(big.length);
        expect(entry!.data).toBeUndefined();
    });

    it('caps the list at the newest 50 files with attribution and refuses oversized whole-file fetches', async () => {
        const root = paneRoot();
        mkdirSync(join(root, 'p1'), { recursive: true });
        for (let i = 0; i < 55; i++) {
            const name = `f${String(i).padStart(2, '0')}.txt`;
            writeFileSync(join(root, 'p1', name), `x${i}`);
            const t = new Date(1_700_000_000_000 + i * 1000);
            utimesSync(join(root, 'p1', name), t, t);
        }

        const entries = await scanPane(root, 'p1');
        expect(entries).toHaveLength(50);
        expect(entries[0]!.name).toBe('f54.txt');
        expect(entries[entries.length - 1]!.name).toBe('f05.txt');
        await expect(scanPaneWithAttribution(root, 'p1')).resolves.toMatchObject({ total: 55, truncated: true });

        writeFileSync(join(root, 'p1', 'oversize.mp4'), Buffer.alloc(6 * 1024 * 1024, 1));
        const watcher = new AttachmentWatcher(root, () => {});
        const oversize = (await scanPane(root, 'p1')).find((entry) => entry.name === 'oversize.mp4')!;
        expect(oversize.data).toBeUndefined();
        await expect(watcher.fetch('p1', oversize.id)).resolves.toBeNull();
    });

    it('returns [] for missing or out-of-root pane dirs without throwing', async () => {
        const root = paneRoot();
        const outside = `${root}-outside`;
        mkdirSync(outside, { recursive: true });
        roots.push(outside);
        writeFileSync(join(outside, 'private.txt'), 'nope');
        expect(await scanPane(root, 'nope')).toEqual([]);
        expect(await scanPane(root, `../${outside.split('/').pop()}`)).toEqual([]);
    });
});

describe('AttachmentWatcher', () => {
    function collect(root: string, rescanMs: number) {
        const emits: { paneId: string; attachments: SessionAttachment[]; total: number | undefined; truncated: boolean | undefined }[] = [];
        const watcher = new AttachmentWatcher(
            root,
            (paneId, attachments, total, truncated) => emits.push({ paneId, attachments, total, truncated }),
            rescanMs,
        );
        const waitFor = (count: number, timeoutMs = 3000) =>
            new Promise<void>((resolve, reject) => {
                const started = Date.now();
                const tick = () => {
                    if (emits.length >= count) return resolve();
                    if (Date.now() - started > timeoutMs) {
                        return reject(new Error(`timed out waiting for ${count} emits (got ${emits.length})`));
                    }
                    setTimeout(tick, 10);
                };
                tick();
            });
        return { watcher, emits, waitFor };
    }

    it('resolves a plugin filename once, then pins encrypted chunks to the content id', async () => {
        const root = paneRoot();
        mkdirSync(join(root, 'p1'), { recursive: true });
        writeFileSync(join(root, 'p1', 'build.apk'), 'first chunk and the rest');
        const watcher = new AttachmentWatcher(root, () => {});
        try {
            const first = await watcher.read('p1', 'build.apk', 0, 5);
            expect(first).toMatchObject({
                id: createHash('sha256').update('first chunk and the rest').digest('hex'),
                name: 'build.apk',
                offset: 0,
                data: Buffer.from('first').toString('base64'),
            });
            await expect(watcher.read('p1', first!.id, 5, 5)).resolves.toMatchObject({
                id: first!.id,
                offset: 5,
                data: Buffer.from(' chun').toString('base64'),
            });
        } finally {
            watcher.dispose();
        }
    });

    it('resendAll re-emits an unchanged pane so a late client still gets ids', async () => {
        const root = paneRoot();
        mkdirSync(join(root, 'p1'), { recursive: true });
        writeFileSync(join(root, 'p1', 'a.png'), PIXEL);
        const { watcher, emits, waitFor } = collect(root, 20);
        watcher.start();
        try {
            await waitFor(1);
            const before = emits.length;
            // Nothing changed: the signature guard must suppress this one.
            await watcher.rescanAll();
            expect(emits.length).toBe(before);
            // A client just connected, so the same list has to go out again.
            await watcher.resendAll();
            expect(emits.length).toBe(before + 1);
            expect(emits[emits.length - 1]!.attachments[0]!.name).toBe('a.png');
        } finally {
            watcher.dispose();
        }
    });

    it('inlines data only for ids never emitted; re-emit carries them metadata-only', async () => {
        const root = paneRoot();
        mkdirSync(join(root, 'p1'), { recursive: true });
        writeFileSync(join(root, 'p1', 'a.png'), PIXEL);
        const { watcher, emits, waitFor } = collect(root, 20);
        watcher.start();
        try {
            await waitFor(1);
            const first = emits[0]!;
            expect(first.paneId).toBe('p1');
            expect(first.attachments[0]).toMatchObject({ name: 'a.png', data: PIXEL_B64 });
            expect(first.attachments[0]!.id).toMatch(/^[0-9a-f]{64}$/);

            // New file, same pane: a.png (known id) metadata-only, b.png inlined.
            writeFileSync(join(root, 'p1', 'b.png'), Buffer.from('second-pixel'));
            await waitFor(2);
            const second = emits[1]!;
            const byName = new Map(second.attachments.map((entry) => [entry.name, entry]));
            expect(byName.get('a.png')).toEqual({
                id: first.attachments[0]!.id,
                name: 'a.png',
                mimeType: 'image/png',
                size: PIXEL.length,
                at: expect.any(Number),
            });
            expect(byName.get('a.png')!.data).toBeUndefined();
            expect(byName.get('b.png')).toMatchObject({
                name: 'b.png',
                data: Buffer.from('second-pixel').toString('base64'),
            });
        } finally {
            watcher.dispose();
        }
    });

    it('bounds the aggregate first emit and leaves excess previews metadata-only', async () => {
        const root = paneRoot();
        mkdirSync(join(root, 'p1'), { recursive: true });
        for (let index = 0; index < 6; index += 1) {
            writeFileSync(join(root, 'p1', `${index}.mp4`), Buffer.alloc(1024 * 1024, index + 1));
        }
        const { watcher, emits, waitFor } = collect(root, 20);
        watcher.start();
        try {
            await waitFor(1);
            const attachments = emits[0]!.attachments;
            expect(emits[0]).toMatchObject({ total: 6, truncated: false });
            const inlineBytes = attachments.reduce((total, entry) => total + (entry.data === undefined ? 0 : Buffer.byteLength(entry.data)), 0);
            expect(attachments).toHaveLength(6);
            expect(inlineBytes).toBeGreaterThan(0);
            expect(inlineBytes).toBeLessThanOrEqual(MAX_INITIAL_INLINE_BYTES);
            expect(attachments.filter((entry) => entry.data === undefined).length).toBeGreaterThan(0);
        } finally {
            watcher.dispose();
        }
    });

    it('emits attribution when an older overflow file is added and removed', async () => {
        const root = paneRoot();
        mkdirSync(join(root, 'p1'), { recursive: true });
        for (let i = 0; i < 50; i++) {
            const path = join(root, 'p1', `f${i}.txt`);
            writeFileSync(path, String(i));
            const time = new Date(1_700_000_000_000 + i * 1000);
            utimesSync(path, time, time);
        }
        const { watcher, emits, waitFor } = collect(root, 1000);
        watcher.start();
        try {
            await waitFor(1);
            expect(emits[0]).toMatchObject({ total: 50, truncated: false });
            const older = join(root, 'p1', 'older.txt');
            writeFileSync(older, 'older');
            const oldTime = new Date(1_600_000_000_000);
            utimesSync(older, oldTime, oldTime);
            await watcher.rescanAll();
            await waitFor(2);
            expect(emits[1]).toMatchObject({ total: 51, truncated: true });
            rmSync(older);
            await watcher.rescanAll();
            await waitFor(3);
            expect(emits[2]).toMatchObject({ total: 50, truncated: false });
        } finally {
            watcher.dispose();
        }
    });

    it('same files scanned repeatedly produce exactly one emit (metadata signature stable)', async () => {
        const root = paneRoot();
        mkdirSync(join(root, 'p1'), { recursive: true });
        writeFileSync(join(root, 'p1', 'a.png'), PIXEL);
        const { watcher, emits, waitFor } = collect(root, 15);
        watcher.start();
        try {
            await waitFor(1);
            // Let several backstop ticks run; nothing changed -> still one emit.
            await new Promise((resolve) => setTimeout(resolve, 120));
            expect(emits).toHaveLength(1);
            // A real change emits once more, then goes quiet again.
            writeFileSync(join(root, 'p1', 'b.png'), Buffer.from('x'));
            await waitFor(2);
            await new Promise((resolve) => setTimeout(resolve, 120));
            expect(emits).toHaveLength(2);
        } finally {
            watcher.dispose();
        }
    });

    it('interval backstop emits for a pane dir that pre-existed start() (no fs event)', async () => {
        const root = paneRoot();
        mkdirSync(join(root, 'p2'), { recursive: true });
        writeFileSync(join(root, 'p2', 'shot.png'), PIXEL);
        const { watcher, emits, waitFor } = collect(root, 15);
        watcher.start();
        try {
            // File existed before start(): fs.watch never fires for it; only the
            // rescan interval can discover this pane.
            await waitFor(1);
            expect(emits[0]!.paneId).toBe('p2');
            expect(emits[0]!.attachments[0]).toMatchObject({ name: 'shot.png', data: PIXEL_B64 });
        } finally {
            watcher.dispose();
        }
    });
});
