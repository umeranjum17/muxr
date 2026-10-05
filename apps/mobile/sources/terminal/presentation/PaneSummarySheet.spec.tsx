import { describe, expect, it, vi } from 'vitest';
import React from 'react';
import TestRenderer from 'react-test-renderer';
import { createHash } from 'node:crypto';

/**
 * The sheet must never show a summary or a way to make one unless BYOKit's
 * on-device kit says it is ready. The kit is real here; only its native
 * binding, its file store and the host read are the kit's own test doubles or
 * fakes, with a small model file in place of the pinned 1.1 GB one.
 */

const paneRead = vi.hoisted(() => vi.fn());
const device = vi.hoisted(() => ({ files: {} as Record<string, Uint8Array>, replies: [] as string[] }));

vi.mock('react-native', () => ({ ActivityIndicator: 'ActivityIndicator', Pressable: 'Pressable', Text: 'Text', View: 'View',
    AppState: { addEventListener: () => ({ remove: () => undefined }) } }));
vi.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ bottom: 0 }) }));
vi.mock('react-native-unistyles', () => ({ useUnistyles: () => ({ theme: { colors: { text: '#fff', textSecondary: '#999', surface: '#111', surfaceHigh: '#222', scrim: '#000', accent: '#0af' } } }) }));
vi.mock('@/components/ActionButton', () => ({ ActionButton: (props: any) => React.createElement('Pressable', { accessibilityLabel: props.title, onPress: props.onPress }) }));
vi.mock('@/catalog/sync', () => ({ sync: { request: paneRead } }));
vi.mock('../infrastructure/onDeviceModel', async () => {
    const { LocalModel, model } = await import('@byokit/infer');
    const { fakeLlama, memoryModelStore } = await import('@byokit/infer/testing');
    const bytes = new TextEncoder().encode('gguf');
    const small = { ...model(), bytes: bytes.byteLength, sha256: createHash('sha256').update(bytes).digest('hex') };
    device.files[small.url] = new TextEncoder().encode('fake');
    const llama = fakeLlama({ reply: () => device.replies.shift() ?? '{}' });
    return {
        openOnDeviceModel: (onState: any) => new LocalModel({ model: small, store: memoryModelStore(device.files).store,
            initLlama: llama.initLlama, device: { platform: 'android', abi: 'arm64-v8a' }, onState }),
        fixBytes: () => { device.files[small.url] = bytes; },
    };
});

// eslint-disable-next-line
import { PaneSummarySheet } from './PaneSummarySheet';
// @ts-expect-error fixBytes exists only on the mock above.
import { fixBytes } from '../infrastructure/onDeviceModel';

const text = (renderer: any) => renderer.root.findAll((node: any) => node.type === 'Text').map((node: any) => [node.props.children].flat().join('')).join('\n');
const button = (renderer: any, label: string) => renderer.root.findAll((node: any) => node.type === 'Pressable' && node.props.accessibilityLabel === label)[0];
const settle = () => TestRenderer.act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });

describe('pane summary sheet', () => {
    it('downloads the kit model, refuses a bad file, then summarizes the pane on the kit alone', async () => {
        let renderer: any;
        TestRenderer.act(() => { renderer = TestRenderer.create(<PaneSummarySheet sessionId="s1" onClose={() => undefined} />); });
        await settle();
        expect(text(renderer)).toContain('Download the model first (1 MB)');
        expect(button(renderer, 'Summarize output')).toBeUndefined();

        // A download that does not match the pinned hash is removed, never loaded.
        await TestRenderer.act(async () => { button(renderer, 'Download model').props.onPress(); });
        await settle();
        expect(text(renderer)).toContain('didn\'t match the expected model');
        expect(button(renderer, 'Summarize output')).toBeUndefined();

        fixBytes();
        await TestRenderer.act(async () => { button(renderer, 'Try download again').props.onPress(); });
        await settle();
        expect(text(renderer)).toContain('made on this phone');

        device.replies.push(JSON.stringify({ enough: true, lines: ['Tests pass.', 'Build green.', 'PR opened.', 'Waiting on review.'] }));
        paneRead.mockResolvedValue({ text: '$ yarn test\n\n\n  164 passed in the mobile workspace, 0 failed   \n', truncated: false });
        await TestRenderer.act(async () => { button(renderer, 'Summarize output').props.onPress(); });
        await settle();
        expect(paneRead).toHaveBeenCalledWith('pane.read', { sessionId: 's1', source: 'recent', lines: 400 });
        const summary = renderer.root.findAll((node: any) => node.props.accessibilityLabel === 'Summary')[0];
        expect(summary.findAllByType('Text').map((node: any) => node.props.children)).toEqual(['Tests pass.', 'Build green.', 'PR opened.', 'Waiting on review.']);

        // Too little output is the kit's call, said in its words, not a summary.
        paneRead.mockResolvedValue({ text: '$ ls\n', truncated: false });
        await TestRenderer.act(async () => { button(renderer, 'Summarize again').props.onPress(); });
        await settle();
        expect(text(renderer)).toContain('Not enough recent output to summarize.');
    });
});
