import { afterEach, expect, it, vi } from 'vitest';
import React from 'react';
import TestRenderer from 'react-test-renderer';

const link = vi.hoisted(() => ({
    options: null as null | { linkHandler: { activate: (event: MouseEvent, url: string) => void; hover?: (event: MouseEvent, url: string, range: { start: { x: number; y: number }; end: { x: number; y: number } }) => void; leave?: () => void } },
    plainTap: null as null | ((event: MouseEvent, url: string) => void),
    onData: null as null | ((base64: string) => void),
    grid: { cols: 80, cellWidth: 10, linkCol: 2 },
}));

vi.mock('react-native', () => ({ View: 'View', Text: 'Text', StyleSheet: { create: (styles: unknown) => styles } }));
vi.mock('@xterm/xterm', () => ({
    Terminal: class {
        get cols() { return link.grid.cols; }
        rows = 24;
        buffer = { active: { viewportY: 0, getLine: (row: number) => row === 1 ? {
            isWrapped: false,
            translateToString: () => '  docs',
            getCell: (col: number) => ({
                getWidth: () => 1, getChars: () => col === link.grid.linkCol ? 'd' : ' ',
                hasExtendedAttrs: () => col === link.grid.linkCol ? 1 : 0, extended: { get urlId() { return col === link.grid.linkCol ? 7 : 0; } },
            }),
        } : undefined } };
        _core = {
            _oscLinkService: { getLinkData: (id: number) => id === 7 ? { uri: 'https://example.test/osc8' } : undefined },
            _renderService: { dimensions: { css: { cell: { get width() { return link.grid.cellWidth; }, height: 18 } } } },
        };
        options: unknown;
        constructor(options: typeof link.options) { this.options = options; link.options = options; }
        loadAddon() {}
        open() {}
        onRender() {}
        onData() {}
        write() {}
        dispose() {}
    },
}));
vi.mock('@xterm/addon-fit', () => ({ FitAddon: class { fit() {} } }));
vi.mock('@xterm/addon-web-links', () => ({ WebLinksAddon: class {
    constructor(tap: typeof link.plainTap) { link.plainTap = tap; }
} }));
vi.mock('@xterm/addon-webgl', () => ({ WebglAddon: class { dispose() {} } }));
vi.mock('../application/OpenTerminal', () => ({ openTerminal: () => Promise.resolve({
    onData: (callback: (base64: string) => void) => { link.onData = callback; },
    onPredictedData() {}, onState() {}, onClose() {}, resize() {}, sendText() {}, close() {},
}) }));
vi.mock('../application/recentOutput', () => ({ setTerminalColumns: () => undefined, recordTerminalOutput: () => undefined }));
vi.mock('@/utils/openExternalUrl', () => ({ openExternalUrl: () => Promise.resolve() }));
vi.mock('@/catalog/store', () => ({ useLocalSetting: (key: string) => (key === 'terminalFont' ? 'system' : 3) }));

import { TerminalView } from './TerminalView.web';

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

it('resolves a held OSC 8 cell after repeat holds and unrelated output while taps keep their card', async () => {
    vi.useFakeTimers();
    const scheduled: Array<() => void> = [];
    const listeners = new Map<string, (event: any) => void>();
    const rect = { left: 10, top: 5, width: 800, height: 432 };
    const screenRect = { ...rect };
    let lastCell: number | null = null;
    const screen = {
        style: {},
        getBoundingClientRect: () => screenRect,
        dispatchEvent(event: { type: string; clientX?: number }) {
            if (event.type === 'mouseleave') link.options?.linkHandler.leave?.();
            if (event.type === 'mousemove') {
                const cell = Math.floor(((event.clientX ?? 0) - rect.left) / 10) + 1;
                if (cell === lastCell) return;
                lastCell = cell;
                if (cell === 3) link.options?.linkHandler.hover?.(event as MouseEvent, 'https://example.test/osc8', { start: { x: 3, y: 2 }, end: { x: 12, y: 2 } });
                else link.options?.linkHandler.leave?.();
            }
        },
    };
    const host = {
        style: {},
        getBoundingClientRect: () => rect,
        querySelector: (selector: string) => selector === '.xterm-screen' ? screen : null,
        addEventListener: (name: string, handler: (event: any) => void) => listeners.set(name, handler),
        removeEventListener: (name: string) => listeners.delete(name),
    };
    vi.stubGlobal('MouseEvent', class {
        clientX: number;
        clientY: number;
        constructor(public type: string, coordinates: { clientX: number; clientY: number } = { clientX: 0, clientY: 0 }) {
            this.clientX = coordinates.clientX;
            this.clientY = coordinates.clientY;
        }
    });
    vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
    vi.stubGlobal('requestAnimationFrame', (callback: () => void) => { scheduled.push(callback); return scheduled.length; });
    vi.stubGlobal('cancelAnimationFrame', () => undefined);
    vi.stubGlobal('window', { devicePixelRatio: 1, addEventListener() {}, removeEventListener() {}, matchMedia: () => ({ addEventListener() {}, removeEventListener() {} }) });
    vi.stubGlobal('document', { addEventListener() {}, removeEventListener() {} });
    const reached = vi.fn();
    let renderer: ReturnType<typeof TestRenderer.create>;
    await TestRenderer.act(async () => {
        renderer = TestRenderer.create(<TerminalView sessionId="pane" onLinkPress={reached} />, {
            createNodeMock: ({ type, props }) => type === 'View' && props.style?.position !== 'relative' ? host : null,
        });
        await Promise.resolve();
    });

    TestRenderer.act(() => {
        listeners.get('touchstart')!({ touches: [{ clientX: 34, clientY: 23 }] });
        vi.advanceTimersByTime(501);
        listeners.get('touchend')!({ touches: [], cancelable: true, preventDefault() {} });
        screen.dispatchEvent({ type: 'mouseleave' });
        listeners.get('touchstart')!({ touches: [{ clientX: 34, clientY: 23 }] });
        vi.advanceTimersByTime(501);
        listeners.get('touchend')!({ touches: [], cancelable: true, preventDefault() {} });
        link.onData!('eA==');
        for (const frame of scheduled.splice(0)) frame();
        listeners.get('touchstart')!({ touches: [{ clientX: 34, clientY: 23 }] });
        vi.advanceTimersByTime(501);
        listeners.get('touchend')!({ touches: [], cancelable: true, preventDefault() {} });
    });
    expect(reached.mock.calls).toEqual([
        ['https://example.test/osc8', { x: 24, y: 18 }],
        ['https://example.test/osc8', { x: 24, y: 18 }],
        ['https://example.test/osc8', { x: 24, y: 18 }],
    ]);
    TestRenderer.act(() => {
        listeners.get('touchstart')!({ touches: [{ clientX: 200, clientY: 23 }] });
        vi.advanceTimersByTime(501);
        listeners.get('touchend')!({ touches: [], cancelable: true, preventDefault() {} });
    });
    expect(reached).toHaveBeenCalledTimes(3);
    rect.width = 360;
    screenRect.left = 14;
    screenRect.width = 344;
    link.grid.cols = 43;
    link.grid.cellWidth = 8;
    link.grid.linkCol = 37;
    TestRenderer.act(() => {
        listeners.get('touchstart')!({ touches: [{ clientX: 314, clientY: 23 }] });
        vi.advanceTimersByTime(501);
        listeners.get('touchend')!({ touches: [], cancelable: true, preventDefault() {} });
        screenRect.top = 25;
        listeners.get('touchstart')!({ touches: [{ clientX: 314, clientY: 46 }] });
        vi.advanceTimersByTime(501);
        listeners.get('touchend')!({ touches: [], cancelable: true, preventDefault() {} });
    });
    expect(reached.mock.calls.slice(3)).toEqual([
        ['https://example.test/osc8', { x: 304, y: 18 }],
        ['https://example.test/osc8', { x: 304, y: 41 }],
    ]);
    link.options?.linkHandler.activate({ clientX: 34, clientY: 23 } as MouseEvent, 'https://example.test/osc8');
    link.plainTap?.({ clientX: 34, clientY: 23 } as MouseEvent, 'https://example.test/plain');
    expect(reached.mock.calls.map(([url]) => url)).toEqual([
        'https://example.test/osc8', 'https://example.test/osc8', 'https://example.test/osc8', 'https://example.test/osc8',
        'https://example.test/osc8', 'https://example.test/osc8', 'https://example.test/plain',
    ]);
    TestRenderer.act(() => renderer!.unmount());
});
