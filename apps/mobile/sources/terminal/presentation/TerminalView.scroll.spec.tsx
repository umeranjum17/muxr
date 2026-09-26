import { afterEach, expect, it, vi } from 'vitest';
import React from 'react';
import TestRenderer from 'react-test-renderer';

const state = vi.hoisted(() => ({ onData: undefined as ((data: string) => void) | undefined, scroll: vi.fn() }));

vi.mock('react-native', () => ({
    AppState: { currentState: 'active', addEventListener: () => ({ remove() {} }) },
    View: 'View',
}));
vi.mock('expo-router', () => ({ useFocusEffect: () => undefined }));
vi.mock('@react-navigation/native', () => ({ useIsFocused: () => true }));
vi.mock('expo-libghostty', () => ({ TerminalView: 'GhosttyView' }));
vi.mock('@/catalog/store', () => ({ useLocalSetting: () => false, useLocalSettingMutable: () => [3, () => undefined] }));
vi.mock('@/catalog/diagnostics', () => ({ recordTerminalResize() {}, recordTerminalScrollClamped() {}, recordTerminalScrollRows() {}, recordTerminalScrollTimeout() {} }));
vi.mock('../application/OpenTerminal', () => ({
    openTerminal: async () => ({
        onData: (callback: (data: string) => void) => { state.onData = callback; },
        onPredictedData() {}, onState() {}, onClose() {}, scroll: state.scroll,
        resize() {}, repaint() {}, close() {}, recordFrameWritten() {},
    }),
}));
vi.mock('../application/terminalAhead', () => ({ claimTerminalAhead: () => undefined, rememberTerminalGrid() {} }));
vi.mock('../application/recentOutput', () => ({ recordTerminalOutput() {}, setTerminalColumns() {} }));
vi.mock('@/utils/openExternalUrl', () => ({ openExternalUrl: async () => undefined }));
vi.mock('@/theme', () => ({ terminalCanvas: '#000' }));

import { TerminalView } from './TerminalView';

afterEach(() => { state.onData = undefined; state.scroll.mockClear(); vi.unstubAllGlobals(); });

it('releases the rendered terminal scroll gate when output arrives', async () => {
    const frames: Array<() => void> = [];
    vi.stubGlobal('requestAnimationFrame', (run: () => void) => { frames.push(run); return frames.length; });
    vi.stubGlobal('cancelAnimationFrame', () => undefined);
    let renderer!: ReturnType<typeof TestRenderer.create>;
    await TestRenderer.act(async () => {
        renderer = TestRenderer.create(<TerminalView sessionId="pane" />, {
            createNodeMock: ({ type }) => type === 'GhosttyView' ? { write: async () => undefined, showKeyboard: async () => undefined, hideKeyboard: async () => undefined } : null,
        });
    });
    const surface = renderer.root.findByType('View');
    await TestRenderer.act(async () => {
        surface.props.onLayout({ nativeEvent: { layout: { width: 800, height: 400 } } });
        await Promise.resolve();
        await Promise.resolve();
    });
    const ghostty = renderer.root.findByType('GhosttyView');
    await TestRenderer.act(async () => {
        ghostty.props.onResize({ nativeEvent: { cols: 80, rows: 24 } });
        await Promise.resolve();
        await Promise.resolve();
    });
    const scroll = () => TestRenderer.act(() => {
        ghostty.props.onScroll({ nativeEvent: { rows: -8 } });
        frames.shift()?.();
    });
    scroll();
    expect(state.scroll).toHaveBeenCalledTimes(1);
    scroll();
    expect(state.scroll).toHaveBeenCalledTimes(1);
    await TestRenderer.act(async () => { state.onData?.('eA=='); await Promise.resolve(); });
    TestRenderer.act(() => { frames.shift()?.(); });
    expect(state.scroll).toHaveBeenCalledTimes(2);
    TestRenderer.act(() => renderer.unmount());
});
