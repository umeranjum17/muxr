import { describe, expect, it, vi } from 'vitest';

const previewMocks = vi.hoisted(() => ({
    request: vi.fn(),
    settings: { mode: 'hosted' as const, machineId: 'machine-1' },
}));

vi.mock('@/connection', () => ({
    getCachedConnectionSettings: () => previewMocks.settings,
}));
// The app calls the typed artifact wire; these specs stand in for the transport
// under it, so the stub answers the canonical names directly.
vi.mock('@/catalog/sync', () => ({
    sync: {
        request: previewMocks.request,
        artifactRead: (sessionId: string, artifactId: string, offset: number, length: number, timeoutMs?: number) =>
            previewMocks.request('artifact.read', { sessionId, artifactId, offset, length }, timeoutMs),
    },
}));
import { buildSharedArtifactTimeline, planArtifactHeal, sharedArtifactDisplayName } from '@/catalog/infrastructure/artifactSupport';
import { createArtifactWire } from '@/catalog/infrastructure/artifactWire';
import { boundText } from '@/utils/boundedText';
import { estimateStoredBlobBytes, blobUri, readBlobText, pruneBlobs, saveBlob } from './artifactBlobs.web';
import { boundSessionFileCache } from '@/catalog/application/sessionFileCache';
import { artifactPreview } from './artifactPreview.web';
import { readRichArtifact } from './richArtifactPreview';
import { richPreviewHtml } from './richPreviewHtml';
import { svgTextLabels } from '@/components/artifact/mermaidLabels';

describe('artifact/file guardrail helpers', () => {
    it('builds newest-first Shared Artifacts history without exposing a path', () => {
        const now = new Date(2026, 8, 19, 12).getTime();
        const yesterday = new Date(2026, 8, 18, 15).getTime();
        const rows = buildSharedArtifactTimeline([
            { id: 'old', name: 'notes.md', at: yesterday },
            { id: 'new', name: 'login-fixed.png', at: now - 1000 },
            { id: 'newest', name: 'capture.png', at: now },
        ], now);
        expect(rows.map((row) => row.type === 'day' ? row.label : row.artifact.name)).toEqual([
            'Today', 'capture.png', 'login-fixed.png', 'Yesterday', 'notes.md',
        ]);
        expect(sharedArtifactDisplayName('/private/build/login-fixed.png')).toBe('login-fixed');
    });

    it('bounds heal payload accounting and source lines/chars before rendering', () => {
        expect(estimateStoredBlobBytes('aGVsbG8=')).toBe(13);
        const plan = planArtifactHeal(Array.from({ length: 10 }, (_, i) => ({ id: String(i), size: 512 * 1024 })));
        expect(plan.candidates).toHaveLength(8);
        expect(plan.deferredIds).toContain('8');
        expect(plan.unavailableIds).toEqual([]);
        const nextOpening = planArtifactHeal(Array.from({ length: 10 }, (_, i) => ({ id: String(i), size: 512 * 1024 })).filter((entry) => plan.deferredIds.includes(entry.id)));
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

    it('coalesces one authenticated image read while keeping object URL ownership independent', async () => {
        previewMocks.request.mockReset();
        let objectUrls = 0;
        const createObjectURL = vi.fn(() => `blob:preview-${++objectUrls}`);
        const revokeObjectURL = vi.fn();
        vi.stubGlobal('URL', { createObjectURL, revokeObjectURL });
        const download = Promise.withResolvers<{ id: string; offset: number; size: number; data: string }>();
        previewMocks.request.mockReturnValue(download.promise);
        const artifact = {
            type: 'attachment' as const,
            id: 'a'.repeat(64),
            name: 'preview.png',
            mimeType: 'image/png',
            size: 5,
        };
        try {
            const first = artifactPreview('session-1', artifact);
            const second = artifactPreview('session-1', artifact);
            expect(previewMocks.request).toHaveBeenCalledTimes(1);
            download.resolve({ id: artifact.id, offset: 0, size: 5, data: 'aGVsbG8=' });
            const sources = await Promise.all([first, second]);
            expect(sources.map((source) => source.uri)).toEqual(['blob:preview-1', 'blob:preview-2']);
            sources.forEach((source) => source.dispose?.());
            expect(revokeObjectURL.mock.calls).toEqual([['blob:preview-1'], ['blob:preview-2']]);

            previewMocks.request.mockResolvedValue({ id: artifact.id, offset: 0, size: 5, data: 'aGVsbG8=' });
            const later = await artifactPreview('session-1', artifact);
            expect(previewMocks.request).toHaveBeenCalledTimes(2);
            later.dispose?.();
        } finally {
            vi.unstubAllGlobals();
        }
    });
    it('opens a bounded document through the real read transport and rejects changed or retargeted data', async () => {
        previewMocks.request.mockReset();
        const artifact = { type: 'attachment' as const, id: 'preview', name: 'notes.md', size: 5 };
        previewMocks.request.mockResolvedValue({ id: 'preview', offset: 0, size: 5, data: 'aGVsbG8=' });
        const result = await readRichArtifact('session-1', artifact, new AbortController().signal);
        expect(result).toEqual({ kind: 'markdown', base64: 'aGVsbG8=' });
        const html = richPreviewHtml('window.renderMuxrArtifact = () => {};', result, { dark: false, surface: '#fff', surfaceHigh: '#f8f8f8', surfaceHighest: '#f0f0f0', text: '#000', textSecondary: '#8e8e93', divider: '#eaeaea' });
        expect(html).toContain("connect-src 'none'");
        expect(html).toContain('"base64":"aGVsbG8="');
        previewMocks.request.mockClear();
        await expect(readRichArtifact('session-1', { ...artifact, size: 300000 }, new AbortController().signal)).rejects.toThrow('preview limit');
        expect(previewMocks.request).not.toHaveBeenCalled();
        previewMocks.request.mockResolvedValue({ id: 'preview', offset: 0, size: 6, data: 'aGVsbG8=' });
        await expect(readRichArtifact('session-1', artifact, new AbortController().signal)).rejects.toThrow('changed');
        previewMocks.request.mockImplementation(async () => {
            previewMocks.settings.machineId = 'machine-2';
            return { id: 'preview', offset: 0, size: 5, data: 'aGVsbG8=' };
        });
        try {
            await expect(readRichArtifact('session-1', artifact, new AbortController().signal)).rejects.toThrow('connection changed');
        } finally { previewMocks.settings.machineId = 'machine-1'; }
    });

    // The packaged renderer once painted node boxes with no label at all: Mermaid
    // emitted the labels as <foreignObject> HTML and the diagram sanitizer forbids
    // that tag. This is that exact Mermaid 11 flowchart output, node for node.
    it('carries Mermaid foreignObject node labels into SVG text the diagram sanitizer keeps', () => {
        const rendered = svgTextLabels('<svg id="svg-diagram-0"><g class="node"><rect class="basic label-container" x="-46.5" y="-27" width="93" height="54"></rect>'
            + '<g class="label" transform="translate(-16.5, -12)"><foreignObject width="32.9" height="24"><div xmlns="http://www.w3.org/1999/xhtml" style="display: table-cell;"><span class="nodeLabel"><p>Beta</p></span></div></foreignObject></g></g>'
            + '<g class="label"><foreignObject x="4" width="97.9" height="24"><div xmlns="http://www.w3.org/1999/xhtml"><span class="nodeLabel"><p>Phone<br/>&lt;b&gt;testing&lt;/b&gt;</p></span></div></foreignObject></g></svg>');
        expect(rendered).not.toContain('foreignObject');
        expect(rendered).toContain('<text x="16.45" y="12" text-anchor="middle" dominant-baseline="central"><tspan x="16.45" dy="0em">Beta</tspan></text>');
        // Two lines centred as a block, and a label carrying markup stays escaped text.
        expect(rendered).toContain('<text x="52.95" y="12" text-anchor="middle" dominant-baseline="central"><tspan x="52.95" dy="-0.55em">Phone</tspan><tspan x="52.95" dy="1.1em">&lt;b&gt;testing&lt;/b&gt;</tspan></text>');
        expect(svgTextLabels('<svg><text>Beta</text></svg>')).toBe('<svg><text>Beta</text></svg>');
    });

    // Mermaid escapes what it draws, but the rewrite runs before the sanitizer, so
    // no shape of markup inside a label may leave it as markup: a nested tag whose
    // removal would reassemble a live one, an unterminated tag, and markup that
    // arrives already encoded all have to come out as inert, escaped text.
    it('carries malicious Mermaid labels out as inert text, whatever shape the markup arrives in', () => {
        const label = (html: string) => svgTextLabels(`<svg><g class="label"><foreignObject width="40" height="24">${html}</foreignObject></g></svg>`);
        for (const html of [
            '<div><scr<span>ipt>alert(1)</scr<span>ipt></div>',
            '<div><img src=x onerror="alert(1)"><p>Ok</p></div>',
            '<div><p>&lt;img src=x onerror=alert(1)&gt;</p></div>',
            '<div><p>&#60;script&#62;alert(1)&#60;/script&#62;</p></div>',
            '<div><p>Ok</p><script src=x',
            '<div><p>a &lt; b</p><script src=x',
        ]) {
            // The only '<' left anywhere is one of the elements this rewrite writes.
            expect(label(html)).not.toMatch(/<(?!\/?(?:svg|g|text|tspan)\b)/);
        }
        // The text itself survives, escaped, rather than being dropped on the floor.
        expect(label('<div><p>&lt;b&gt;a &amp; b&lt;/b&gt;</p></div>')).toContain('>&lt;b&gt;a &amp; b&lt;/b&gt;</tspan>');
        expect(label('<div><p>1 &lt; 2</p><p>3 &gt; 2</p></div>')).toContain('<tspan x="20" dy="-0.55em">1 &lt; 2</tspan><tspan x="20" dy="1.1em">3 &gt; 2</tspan>');
    });

});

// The artifact unification renamed the protocol methods. A host built before
// the rename answers the legacy names only, so the app has to reach every one
// it uses there and still read one shape back.
describe('Shared Artifacts wire across host versions', () => {
    const chunk = { id: 'a'.repeat(64), name: 'report.md', mimeType: 'text/plain', size: 5, offset: 0, data: 'aGVsbG8=' };

    function fakeHost({ legacy }: { legacy: boolean }) {
        const calls: string[] = [];
        const table: Record<string, unknown> = legacy
            ? {
                'attachment.list': { attachments: [chunk], total: 1, truncated: false },
                'attachment.fetch': { name: 'report.md', mimeType: 'text/plain', data: 'aGVsbG8=' },
                'attachment.read': chunk,
            }
            : {
                'artifact.list': { artifacts: [chunk], total: 1, truncated: false },
                'artifact.fetch': { name: 'report.md', mimeType: 'text/plain', data: 'aGVsbG8=' },
                'artifact.read': chunk,
            };
        return {
            calls,
            request: async (type: string) => {
                calls.push(type);
                if (!(type in table)) throw Object.assign(new Error(`host has no handler for '${type}'`), { code: 'host-contract-mismatch' });
                return table[type];
            },
        };
    }

    it('drives the named methods, and falls back to the pre-rename ones once', async () => {
        const host = fakeHost({ legacy: true });
        const wire = createArtifactWire(host.request as never);

        expect(await wire.list('s1')).toEqual({ artifacts: [chunk], total: 1, truncated: false });
        expect(await wire.fetch('s1', chunk.id)).toMatchObject({ name: 'report.md' });
        expect(await wire.read('s1', chunk.id, 0, 512)).toEqual(chunk);

        // One probe, then the legacy names for the rest of the process.
        expect(host.calls).toEqual([
            'artifact.list', 'attachment.list',
            'attachment.fetch', 'attachment.read',
        ]);
    });

    it('stays on the canonical names when the host knows them, and never swallows a real failure', async () => {
        const modern = fakeHost({ legacy: false });
        const wire = createArtifactWire(modern.request as never);
        await wire.list('s1');
        await wire.list('s1');
        expect(modern.calls).toEqual(['artifact.list', 'artifact.list']);

        const broken = createArtifactWire(async () => {
            throw Object.assign(new Error('this device grant is view-only'), { code: 'forbidden' });
        });
        await expect(broken.list('s1')).rejects.toThrow('view-only');
    });
});
