import { afterEach, expect, it, vi } from 'vitest';
import React from 'react';
import TestRenderer from 'react-test-renderer';
import type { TerminalChannel } from '../application/OpenTerminal';

const state = vi.hoisted(() => ({ onData: undefined as ((data: string) => void) | undefined, scroll: vi.fn(), bottom: vi.fn() }));

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
        onPredictedData() {}, onState() {}, onClose() {}, scroll: state.scroll, bottom: state.bottom,
        resize() {}, repaint() {}, close() {}, recordFrameWritten() {},
    }),
}));
vi.mock('../application/terminalAhead', () => ({ claimTerminalAhead: () => undefined, rememberTerminalGrid() {} }));
vi.mock('../application/recentOutput', () => ({ recordTerminalOutput() {}, setTerminalColumns() {} }));
vi.mock('@/utils/openExternalUrl', () => ({ openExternalUrl: async () => undefined }));
vi.mock('@/theme', () => ({ terminalColorDefaults: { background: '#000', foreground: '#fff', cursor: '#fff', selection: '#fff', ansi: [] } }));

import { TerminalView } from './TerminalView';

afterEach(() => { state.onData = undefined; state.scroll.mockClear(); state.bottom.mockClear(); vi.useRealTimers(); vi.unstubAllGlobals(); });

it('releases scroll travel on output and discards an active fling when Latest is requested', async () => {
    vi.useFakeTimers();
    let channel!: TerminalChannel;
    const frames = new Map<number, () => void>();
    let nextFrame = 0;
    const paint = () => { const due = [...frames.values()]; frames.clear(); for (const run of due) run(); };
    vi.stubGlobal('requestAnimationFrame', (run: () => void) => { frames.set(++nextFrame, run); return nextFrame; });
    vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
    let renderer!: ReturnType<typeof TestRenderer.create>;
    await TestRenderer.act(async () => {
        renderer = TestRenderer.create(<TerminalView sessionId="pane" onChannel={(opened) => { if (opened) channel = opened; }} />, {
            createNodeMock: ({ type }) => type === 'GhosttyView' ? { write: async () => undefined, showKeyboard: async () => undefined, hideKeyboard: async () => undefined } : null,
        });
    });
    const surface = (renderer.root as any).findByType('View');
    await TestRenderer.act(async () => {
        surface.props.onLayout({ nativeEvent: { layout: { width: 800, height: 400 } } });
        await Promise.resolve();
        await Promise.resolve();
    });
    const ghostty = (renderer.root as any).findByType('GhosttyView');
    await TestRenderer.act(async () => {
        ghostty.props.onResize({ nativeEvent: { cols: 80, rows: 24 } });
        await Promise.resolve();
        await Promise.resolve();
    });
    const scroll = () => TestRenderer.act(() => {
        ghostty.props.onScroll({ nativeEvent: { rows: -8 } });
        paint();
    });
    scroll();
    expect(state.scroll).toHaveBeenCalledTimes(1);
    scroll();
    expect(state.scroll).toHaveBeenCalledTimes(1);
    await TestRenderer.act(async () => { state.onData?.('eA=='); await Promise.resolve(); });
    TestRenderer.act(() => { paint(); });
    expect(state.scroll).toHaveBeenCalledTimes(2);
    scroll();
    TestRenderer.act(() => channel.bottom());
    scroll();
    await TestRenderer.act(async () => { state.onData?.('eA=='); await Promise.resolve(); });
    TestRenderer.act(() => { paint(); vi.advanceTimersByTime(500); paint(); });
    expect(state.bottom).toHaveBeenCalledTimes(1);
    expect(state.scroll).toHaveBeenCalledTimes(2);
    TestRenderer.act(() => surface.props.onTouchStart({ nativeEvent: { locationX: 40, locationY: 80 } }));
    scroll();
    expect(state.scroll).toHaveBeenCalledTimes(3);
    TestRenderer.act(() => renderer.unmount());
});
