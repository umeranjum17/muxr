import { describe, expect, it, vi } from 'vitest';

const previewMocks = vi.hoisted(() => ({
    request: vi.fn(),
    settings: { mode: 'hosted' as const, machineId: 'machine-1' },
}));

vi.mock('@/connection', () => ({
    getCachedConnectionSettings: () => previewMocks.settings,
}));
vi.mock('@/catalog/sync', () => ({
    sync: { request: previewMocks.request },
}));
import { estimateBase64Bytes, planAttachmentHeal } from '@/catalog/infrastructure/attachmentSupport';
import { boundText } from '@/utils/boundedText';
import { estimateStoredBlobBytes, blobUri, readBlobText, pruneBlobs, saveBlob } from './attachmentBlobs.web';
import { boundSessionFileCache } from '@/catalog/application/sessionFileCache';
import { attachmentPreview } from './attachmentPreview.web';
import { readRichAttachment } from './richAttachmentPreview';
import { richPreviewHtml } from './richPreviewHtml';

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

    it('coalesces one hosted image read while keeping object URL ownership independent', async () => {
        previewMocks.request.mockReset();
        let objectUrls = 0;
        const createObjectURL = vi.fn(() => `blob:preview-${++objectUrls}`);
        const revokeObjectURL = vi.fn();
        vi.stubGlobal('URL', { createObjectURL, revokeObjectURL });
        const download = Promise.withResolvers<{ id: string; offset: number; size: number; data: string }>();
        previewMocks.request.mockReturnValue(download.promise);
        const attachment = {
            type: 'attachment' as const,
            id: 'a'.repeat(64),
            name: 'preview.png',
            mimeType: 'image/png',
            size: 5,
        };
        try {
            const first = attachmentPreview('session-1', attachment);
            const second = attachmentPreview('session-1', attachment);
            expect(previewMocks.request).toHaveBeenCalledTimes(1);
            download.resolve({ id: attachment.id, offset: 0, size: 5, data: 'aGVsbG8=' });
            const sources = await Promise.all([first, second]);
            expect(sources.map((source) => source.uri)).toEqual(['blob:preview-1', 'blob:preview-2']);
            sources.forEach((source) => source.dispose?.());
            expect(revokeObjectURL.mock.calls).toEqual([['blob:preview-1'], ['blob:preview-2']]);

            previewMocks.request.mockResolvedValue({ id: attachment.id, offset: 0, size: 5, data: 'aGVsbG8=' });
            const later = await attachmentPreview('session-1', attachment);
            expect(previewMocks.request).toHaveBeenCalledTimes(2);
            later.dispose?.();
        } finally {
            vi.unstubAllGlobals();
        }
    });
    it('opens a bounded document through the real read transport and rejects changed or retargeted data', async () => {
        previewMocks.request.mockReset();
        const attachment = { type: 'attachment' as const, id: 'preview', name: 'notes.md', size: 5 };
        previewMocks.request.mockResolvedValue({ id: 'preview', offset: 0, size: 5, data: 'aGVsbG8=' });
        const result = await readRichAttachment('session-1', attachment, new AbortController().signal);
        expect(result).toEqual({ kind: 'markdown', base64: 'aGVsbG8=' });
        const html = richPreviewHtml('window.renderMuxrAttachment = () => {};', result);
        expect(html).toContain("connect-src 'none'");
        expect(html).toContain('"base64":"aGVsbG8="');
        previewMocks.request.mockClear();
        await expect(readRichAttachment('session-1', { ...attachment, size: 300000 }, new AbortController().signal)).rejects.toThrow('preview limit');
        expect(previewMocks.request).not.toHaveBeenCalled();
        previewMocks.request.mockResolvedValue({ id: 'preview', offset: 0, size: 6, data: 'aGVsbG8=' });
        await expect(readRichAttachment('session-1', attachment, new AbortController().signal)).rejects.toThrow('changed');
        previewMocks.request.mockImplementation(async () => {
            previewMocks.settings.machineId = 'machine-2';
            return { id: 'preview', offset: 0, size: 5, data: 'aGVsbG8=' };
        });
        try {
            await expect(readRichAttachment('session-1', attachment, new AbortController().signal)).rejects.toThrow('connection changed');
        } finally { previewMocks.settings.machineId = 'machine-1'; }
    });

});
