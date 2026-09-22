import { afterEach, expect, it, vi } from 'vitest';
import React from 'react';
import TestRenderer from 'react-test-renderer';

const link = vi.hoisted(() => ({
    options: null as null | { linkHandler: { activate: (event: MouseEvent, url: string) => void; hover: (event: MouseEvent, url: string, range: { start: { x: number; y: number }; end: { x: number; y: number } }) => void; leave?: () => void } },
    plainTap: null as null | ((event: MouseEvent, url: string) => void),
}));

vi.mock('react-native', () => ({ View: 'View', Text: 'Text', StyleSheet: { create: (styles: unknown) => styles } }));
vi.mock('@xterm/xterm', () => ({
    Terminal: class {
        cols = 80;
        rows = 24;
        buffer = { active: { viewportY: 0, getLine: () => undefined } };
        options: unknown;
        constructor(options: typeof link.options) { this.options = options; link.options = options; }
        loadAddon() {}
        open() {}
        onRender() {}
        dispose() {}
    },
}));
vi.mock('@xterm/addon-fit', () => ({ FitAddon: class { fit() {} } }));
vi.mock('@xterm/addon-web-links', () => ({ WebLinksAddon: class {
    constructor(tap: typeof link.plainTap) { link.plainTap = tap; }
} }));
vi.mock('@xterm/addon-webgl', () => ({ WebglAddon: class { dispose() {} } }));
vi.mock('../application/OpenTerminal', () => ({ openTerminal: () => new Promise(() => {}) }));
vi.mock('../application/recentOutput', () => ({ setTerminalColumns: () => undefined, recordTerminalOutput: () => undefined }));
vi.mock('@/utils/openExternalUrl', () => ({ openExternalUrl: () => Promise.resolve() }));

import { TerminalView } from './TerminalView.web';

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

it('opens the action card for OSC 8 labels held on the browser terminal while taps keep their card', () => {
    vi.useFakeTimers();
    const listeners = new Map<string, (event: any) => void>();
    const rect = { left: 10, top: 5, width: 800, height: 432 };
    let lastCell: number | null = null;
    const screen = {
        style: {},
        getBoundingClientRect: () => rect,
        dispatchEvent(event: { type: string; clientX?: number }) {
            if (event.type === 'mouseleave') link.options?.linkHandler.leave?.();
            if (event.type === 'mousemove') {
                const cell = Math.floor(((event.clientX ?? 0) - rect.left) / 10) + 1;
                if (cell === lastCell) return;
                lastCell = cell;
                if (cell === 3) link.options?.linkHandler.hover(event as MouseEvent, 'https://example.test/osc8', { start: { x: 3, y: 2 }, end: { x: 12, y: 2 } });
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
    vi.stubGlobal('requestAnimationFrame', () => 1);
    vi.stubGlobal('cancelAnimationFrame', () => undefined);
    vi.stubGlobal('window', { devicePixelRatio: 1, addEventListener() {}, removeEventListener() {}, matchMedia: () => ({ addEventListener() {}, removeEventListener() {} }) });
    vi.stubGlobal('document', { addEventListener() {}, removeEventListener() {} });
    const reached = vi.fn();
    let renderer: ReturnType<typeof TestRenderer.create>;
    TestRenderer.act(() => {
        renderer = TestRenderer.create(<TerminalView sessionId="pane" onLinkPress={reached} />, {
            createNodeMock: ({ type, props }) => type === 'View' && props.style?.position !== 'relative' ? host : null,
        });
    });

    TestRenderer.act(() => {
        listeners.get('touchstart')!({ touches: [{ clientX: 34, clientY: 23 }] });
        vi.advanceTimersByTime(501);
        listeners.get('touchend')!({ touches: [], cancelable: true, preventDefault() {} });
        screen.dispatchEvent({ type: 'mouseleave' });
        listeners.get('touchstart')!({ touches: [{ clientX: 34, clientY: 23 }] });
        vi.advanceTimersByTime(501);
        listeners.get('touchend')!({ touches: [], cancelable: true, preventDefault() {} });
    });
    expect(reached.mock.calls).toEqual([
        ['https://example.test/osc8', { x: 24, y: 18 }],
        ['https://example.test/osc8', { x: 24, y: 18 }],
    ]);
    TestRenderer.act(() => {
        listeners.get('touchstart')!({ touches: [{ clientX: 200, clientY: 23 }] });
        vi.advanceTimersByTime(501);
        listeners.get('touchend')!({ touches: [], cancelable: true, preventDefault() {} });
    });
    expect(reached).toHaveBeenCalledTimes(2);
    link.options?.linkHandler.activate({ clientX: 34, clientY: 23 } as MouseEvent, 'https://example.test/osc8');
    link.plainTap?.({ clientX: 34, clientY: 23 } as MouseEvent, 'https://example.test/plain');
    expect(reached.mock.calls.map(([url]) => url)).toEqual([
        'https://example.test/osc8', 'https://example.test/osc8', 'https://example.test/osc8', 'https://example.test/plain',
    ]);
    TestRenderer.act(() => renderer!.unmount());
});
