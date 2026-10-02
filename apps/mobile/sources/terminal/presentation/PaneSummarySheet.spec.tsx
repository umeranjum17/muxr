import { describe, expect, it, vi } from 'vitest';
import React from 'react';
import TestRenderer from 'react-test-renderer';

/**
 * Summarize is built ahead of BYOKit's on-device kit, so the sheet must never
 * show a summary or a way to make one unless the kit says it is ready. The kit
 * and the host read are the two boundaries faked here; the sheet and its
 * input/output shaping are real.
 */

const kit = vi.hoisted(() => ({ current: undefined as any }));
const paneRead = vi.hoisted(() => vi.fn());

vi.mock('react-native', () => ({ ActivityIndicator: 'ActivityIndicator', Pressable: 'Pressable', Text: 'Text', View: 'View' }));
vi.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ bottom: 0 }) }));
vi.mock('react-native-unistyles', () => ({ useUnistyles: () => ({ theme: { colors: { text: '#fff', textSecondary: '#999', surface: '#111', surfaceHigh: '#222', scrim: '#000', accent: '#0af' } } }) }));
vi.mock('@/components/ActionButton', () => ({ ActionButton: (props: any) => React.createElement('Pressable', { accessibilityLabel: props.title, onPress: props.onPress }) }));
vi.mock('@/catalog/sync', () => ({ sync: { request: paneRead } }));
vi.mock('../application/paneSummary', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../application/paneSummary')>()),
    useOnDeviceSummarizer: () => kit.current,
}));

// eslint-disable-next-line
import { PaneSummarySheet } from './PaneSummarySheet';

const text = (renderer: any) => renderer.root.findAll((node: any) => node.type === 'Text').map((node: any) => [node.props.children].flat().join('')).join('\n');
const button = (renderer: any, label: string) => renderer.root.findAll((node: any) => node.type === 'Pressable' && node.props.accessibilityLabel === label)[0];

function mount() {
    let renderer: any;
    TestRenderer.act(() => { renderer = TestRenderer.create(<PaneSummarySheet sessionId="s1" onClose={() => undefined} />); });
    return renderer!;
}

describe('pane summary sheet', () => {
    it('offers nothing until the kit is ready, then summarizes the pane on the kit alone', async () => {
        const actual = await vi.importActual<typeof import('../application/paneSummary')>('../application/paneSummary');
        kit.current = actual.useOnDeviceSummarizer();
        let renderer = mount();
        expect(text(renderer)).toContain('aren’t available in this build yet');
        expect(button(renderer, 'Summarize output')).toBeUndefined();
        expect(button(renderer, 'Download model')).toBeUndefined();

        const download = vi.fn();
        kit.current = { state: { kind: 'needs-download', bytes: 1_200_000_000 }, download };
        renderer = mount();
        expect(text(renderer)).toContain('(1200 MB)');
        TestRenderer.act(() => { button(renderer, 'Download model').props.onPress(); });
        expect(download).toHaveBeenCalledOnce();

        kit.current = { state: { kind: 'busy' }, summarize: vi.fn() };
        renderer = mount();
        expect(button(renderer, 'Summarize output')).toBeUndefined();

        const summarize = vi.fn(async () => 'Tests pass.\n\nBuild green.\nPR opened.\nWaiting on review.\nExtra line.');
        kit.current = { state: { kind: 'ready' }, summarize };
        paneRead.mockResolvedValue({ text: '$ yarn test\n\n\n  164 passed   \n', truncated: false });
        renderer = mount();
        await TestRenderer.act(async () => { button(renderer, 'Summarize output').props.onPress(); });
        expect(paneRead).toHaveBeenCalledWith('pane.read', { sessionId: 's1', source: 'recent', lines: 400 });
        expect(summarize).toHaveBeenCalledWith('$ yarn test\n  164 passed');
        const summary = renderer.root.findAll((node: any) => node.props.accessibilityLabel === 'Summary')[0];
        expect(summary.findAllByType('Text').map((node: any) => node.props.children)).toEqual(['Tests pass.', 'Build green.', 'PR opened.', 'Waiting on review.']);
        expect(button(renderer, 'Summarize again')).toBeDefined();
    });
});
