import { beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import TestRenderer from 'react-test-renderer';

/**
 * Two consecutive upload failures keep every file; only an explicit Retry
 * uploads again, and only a batch that landed leaves.
 */
const act = TestRenderer.act;
const harness = vi.hoisted(() => ({ requests: 0, mode: 'fail' as 'fail' | 'ok' }));

vi.mock('@/catalog/sync', () => ({
    sync: {
        request: async (_type: string, params: { attachments: Array<{ name: string }> }) => {
            harness.requests += 1;
            if (harness.mode === 'fail') throw new Error('request timed out');
            return { savedPaths: params.attachments.map((item) => `/tmp/${item.name}`) };
        },
    },
}));
vi.mock('@/utils/readFileBytes', () => ({ readFileBytes: async () => new Uint8Array([1]) }));
vi.mock('@/encryption/base64', () => ({ encodeBase64: () => 'AQ==' }));
vi.mock('@/hooks/useImagePicker', () => {
    const ReactModule = React;
    return {
        useImagePicker: () => {
            const [selectedImages, setSelectedImages] = ReactModule.useState<Array<{ id: string; name: string; uri: string; mimeType: string }>>([]);
            return {
                selectedImages,
                pickImages: async () => undefined,
                clearImages: ReactModule.useCallback(() => setSelectedImages([]), []),
                addImages: ReactModule.useCallback((images: typeof selectedImages) => setSelectedImages((prev) => [...prev, ...images]), []),
            };
        },
    };
});

import { useAttachmentUploads } from './useAttachmentUploads';

type Api = ReturnType<typeof useAttachmentUploads>;
function Probe({ onApi }: { onApi: (api: Api) => void }) {
    const api = useAttachmentUploads('pp_1', () => undefined);
    onApi(api);
    return null;
}

const settle = async () => { for (let i = 0; i < 8; i += 1) await Promise.resolve(); };
const files = [{ id: 'a', name: 'a.png', uri: 'file:///a', mimeType: 'image/png', width: 1, height: 1, size: 1 }, { id: 'b', name: 'b.png', uri: 'file:///b', mimeType: 'image/png', width: 1, height: 1, size: 1 }];

beforeEach(() => { harness.requests = 0; harness.mode = 'fail'; });

describe('attachment upload ownership', () => {
    it('keeps failed files through repeated failures and uploads them only on explicit retry', async () => {
        let api!: Api;
        await act(async () => { TestRenderer.create(<Probe onApi={(next) => { api = next; }} />); });
        await act(async () => { api.addImages(files); await settle(); });
        expect(harness.requests).toBe(1);
        expect(api.failed.map((f) => f.id)).toEqual(['a', 'b']);
        expect(api.attachedPaths).toEqual([]);
        // Nothing retries on its own while the files sit in the failed set.
        await act(async () => { await settle(); });
        expect(harness.requests).toBe(1);
        // Second failure: still owned, still both files, no duplicates.
        await act(async () => { api.retryFailed(); await settle(); });
        expect(harness.requests).toBe(2);
        expect(api.failed.map((f) => f.id)).toEqual(['a', 'b']);
        // Connection back: the retried batch lands and leaves the failed set.
        harness.mode = 'ok';
        await act(async () => { api.retryFailed(); await settle(); });
        expect(harness.requests).toBe(3);
        expect(api.failed).toEqual([]);
        expect(api.attachedPaths).toEqual(['/tmp/a.png', '/tmp/b.png']);
    });
});
