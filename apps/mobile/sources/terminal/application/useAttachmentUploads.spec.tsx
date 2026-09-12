import { beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import TestRenderer from 'react-test-renderer';

/**
 * Two consecutive upload failures keep every file; only an explicit Retry
 * uploads again, and only a batch that landed leaves.
 */
const act = TestRenderer.act;
const harness = vi.hoisted(() => ({
    requests: 0,
    mode: 'fail' as 'fail' | 'ok',
    targets: [] as string[],
    readGate: null as null | Promise<void>,
}));

// The hook and the submissions store reach sync through different module
// ids; both resolve to the same fake wire.
vi.mock('@/catalog/application/sync', () => ({ sync: {} }));
vi.mock('@/catalog/sync', () => ({
    sync: {
        saveAttachments: async (machineId: string, sessionId: string, attachments: Array<{ name: string }>) => {
            harness.requests += 1;
            harness.targets.push(`${machineId}/${sessionId}`);
            if (harness.mode === 'fail') throw new Error('request timed out');
            return { savedPaths: attachments.map((item) => `/tmp/${item.name}`) };
        },
    },
}));
vi.mock('@/utils/readFileBytes', () => ({ readFileBytes: async () => { await harness.readGate; return new Uint8Array([1]); } }));
vi.mock('expo-crypto', () => ({ randomUUID: () => 'kept-uploads' }));
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
import { recoverable, useSubmissions } from '@/catalog/application/submissions';

type Api = ReturnType<typeof useAttachmentUploads>;
function Probe({ onApi, machineId = 'host-a' }: { onApi: (api: Api) => void; machineId?: string }) {
    const api = useAttachmentUploads(machineId, 'pp_1', () => undefined);
    onApi(api);
    return null;
}

const settle = async () => { for (let i = 0; i < 8; i += 1) await Promise.resolve(); };
const files = [{ id: 'a', name: 'a.png', uri: 'file:///a', mimeType: 'image/png', width: 1, height: 1, size: 1 }, { id: 'b', name: 'b.png', uri: 'file:///b', mimeType: 'image/png', width: 1, height: 1, size: 1 }];

beforeEach(() => { harness.requests = 0; harness.mode = 'fail'; harness.targets = []; harness.readGate = null; useSubmissions.setState({ byTarget: {} }); });

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

    it('never sends bytes read for one computer to another: a switch during the read keeps the files on the owner', async () => {
        harness.mode = 'ok';
        let release!: () => void;
        harness.readGate = new Promise<void>((resolve) => { release = resolve; });
        let api!: Api;
        let renderer!: ReturnType<typeof TestRenderer.create>;
        // Same shell route on computer A; the file read starts here.
        await act(async () => { renderer = TestRenderer.create(<Probe machineId="host-a" onApi={(next) => { api = next; }} />); });
        await act(async () => { api.addImages([files[0]!]); await settle(); });
        expect(harness.requests).toBe(0);
        // The app switches to computer B (the route remounts under B) while
        // A's bytes are still being read.
        await act(async () => { renderer.update(<Probe key="host-b" machineId="host-b" onApi={(next) => { api = next; }} />); });
        await act(async () => { release(); await settle(); });
        // Nothing was uploaded anywhere, least of all to B.
        expect(harness.requests).toBe(0);
        expect(harness.targets).toEqual([]);
        // A keeps the preview for its own session, recoverable there.
        expect(recoverable({ machineId: 'host-a', sessionId: 'pp_1' })).toMatchObject([{ state: 'refused', pendingUploads: [{ id: 'a' }] }]);
        expect(recoverable({ machineId: 'host-b', sessionId: 'pp_1' })).toEqual([]);
        // B's own uploads go to B, pinned by target.
        await act(async () => { api.addImages([files[1]!]); await settle(); });
        expect(harness.targets).toEqual(['host-b/pp_1']);
        expect(api.attachedPaths).toEqual(['/tmp/b.png']);
    });
});
