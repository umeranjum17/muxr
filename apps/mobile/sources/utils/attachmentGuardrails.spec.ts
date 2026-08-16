import { describe, expect, it, vi } from 'vitest';
import { estimateBase64Bytes, planAttachmentHeal } from '@/sync/attachmentSupport';
import { boundText } from './boundedText';
import { estimateStoredBlobBytes, blobUri, readBlobText, pruneBlobs, saveBlob } from './attachmentBlobs.web';
import { boundSessionFileCache } from '@/sync/sessionFileCache';

describe('attachment/file guardrail helpers', () => {
    it('bounds heal payload accounting and source lines/chars before rendering', () => {
        expect(estimateBase64Bytes('aGVsbG8=')).toBe(5);
        expect(estimateBase64Bytes('not base64')).toBeNull();
        expect(estimateStoredBlobBytes('aGVsbG8=')).toBe(13);
        const plan = planAttachmentHeal(Array.from({ length: 10 }, (_, i) => ({ id: String(i), size: 512 * 1024 })));
        expect(plan.candidates).toHaveLength(8);
        expect(plan.deferredIds).toContain('8');
        expect(plan.unavailableIds).toEqual([]);
        const nextOpening = planAttachmentHeal(Array.from({ length: 10 }, (_, i) => ({ id: String(i), size: 512 * 1024 })).filter((entry) => plan.deferredIds.includes(entry.id)));
        expect(nextOpening.candidates.map((entry) => entry.id)).toEqual(['8', '9']);
        const result = boundText(`${'x'.repeat(300_000)}\nsecond\nthird`);
        expect(result.text.length).toBe(256 * 1024);
        expect(result.omittedChars).toBeGreaterThan(0);
        expect(result.omittedLines).toBe(2);
        const exact = boundText(`${'x\n'.repeat(2000)}`);
        expect(exact.text.split('\n')).toHaveLength(2000);
        expect(exact.omittedLines).toBe(0);
        const cache = Array.from({ length: 12 }, (_, i) => [`file-${i}`, { content: 'x', diff: null, isBinary: false, cachedAt: i }] as const);
        const bounded = boundSessionFileCache(Object.fromEntries(cache), 'file-12', { content: 'new', diff: 'diff', isBinary: false, cachedAt: 12 });
        expect(Object.keys(bounded)).toHaveLength(12);
        expect(bounded['file-0']).toBeUndefined();
        expect(bounded['file-12']).toBeDefined();
    });

    it('evicts oldest web blobs and removes both object URL and text lookup', async () => {
        const createObjectURL = vi.fn((blob: Blob) => `blob:mock-${blob.size}-${createObjectURL.mock.calls.length}`);
        const revokeObjectURL = vi.fn();
        vi.stubGlobal('URL', { createObjectURL, revokeObjectURL });
        try {
            await pruneBlobs(new Set());
            const payload = 'A'.repeat(10 * 1024 * 1024);
            await saveBlob('old', payload, 'txt');
            const saved = await saveBlob('new', payload, 'txt');
            expect(saved.evictedIds).toContain('old');
            expect(await blobUri('old')).toBeNull();
            expect(await readBlobText('old')).toBeNull();
            expect(await blobUri('new')).toMatch(/^blob:mock-/);
            expect(await readBlobText('new')).not.toBeNull();
            expect(revokeObjectURL).toHaveBeenCalledWith(expect.stringContaining('blob:mock-'));
        } finally {
            await pruneBlobs(new Set());
            vi.unstubAllGlobals();
        }
    });
});
