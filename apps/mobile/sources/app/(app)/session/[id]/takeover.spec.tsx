import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import TestRenderer from 'react-test-renderer';

/**
 * Regression: reattaching to an already-running stream (enable fails with
 * "already enabled", the bound port comes from `stream status`) is passive
 * ownership. Leaving the screen must not disable a stream other viewers are
 * still watching; only a stream this screen enabled itself may be disabled.
 */

const shell = vi.hoisted(() => vi.fn());

vi.mock('@/catalog/ops', () => ({ machineBash: shell }));

const theme = {
    colors: {
        text: '#000',
        textSecondary: '#555',
        surface: '#fff',
        surfacePressed: '#eee',
        divider: '#ddd',
        accent: '#00f',
        status: { working: '#0a0', error: '#f00' },
        groupped: { background: '#f5f5f5' },
        button: { primary: { background: '#00f', tint: '#fff' } },
    },
};

vi.mock('react-native', () => ({
    View: 'View',
    Image: 'Image',
    ActivityIndicator: 'ActivityIndicator',
    Pressable: 'Pressable',
    ScrollView: 'ScrollView',
    TextInput: 'TextInput',
    StyleSheet: { hairlineWidth: 1, create: (styles: unknown) => styles },
    Keyboard: { dismiss: vi.fn() },
    useWindowDimensions: () => ({ width: 400, height: 800 }),
}));
vi.mock('react-native-unistyles', () => ({ useUnistyles: () => ({ theme }) }));
vi.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));
vi.mock('expo-router', () => ({ useLocalSearchParams: () => ({ id: 'sess-1' }) }));
vi.mock('react-native-keyboard-controller', () => ({ useKeyboardState: () => ({ isVisible: false, height: 0 }) }));
vi.mock('@/components/StyledText', () => ({ Text: () => null }));
vi.mock('@/constants/Typography', () => ({
    Typography: { default: () => ({}), mono: () => ({}), semiBold: () => ({}) },
}));
vi.mock('@/components/StatusDot', () => ({ StatusDot: () => null }));
vi.mock('@/components/ui', () => ({ cardStyle: () => ({}), ui: { radius: { control: 8 } } }));
vi.mock('@/modal', () => ({ Modal: { confirm: vi.fn(), prompt: vi.fn(), alert: vi.fn() } }));
vi.mock('@/catalog/store', () => ({
    useSession: () => ({ metadata: { path: '/work', host: 'box' } }),
    useSocketStatus: () => ({ status: 'connected' }),
    useHerdrTree: () => ({ workspaces: [] }),
}));
vi.mock('@/herd', () => ({
    agentLabels: () => ({}),
    herdrPaneForSession: () => undefined,
    isShellLabels: () => true,
    middleTruncate: (value: string) => value,
}));
vi.mock('@/text', () => ({ t: (key: string) => key }));
vi.mock('@/preview', () => ({
    attachPreviewTunnel: vi.fn(async () => ({ hostname: 'tunnel.test', port: 1234, close: vi.fn() })),
}));

import TakeoverScreen from './takeover';

class FakeSocket {
    static instances: FakeSocket[] = [];

    readyState = 1;
    onopen: (() => void) | null = null;
    onmessage: ((event: { data: string }) => void) | null = null;
    onerror: (() => void) | null = null;
    onclose: (() => void) | null = null;
    readonly send = vi.fn();
    readonly close = vi.fn();

    constructor() {
        FakeSocket.instances.push(this);
    }
}

const alreadyEnabled = {
    success: false,
    exitCode: 1,
    stderr: '',
    stdout: JSON.stringify({ success: false, data: null, error: 'Streaming is already enabled for this session' }),
};
const statusBound = (port: number) => ({
    success: true,
    exitCode: 0,
    stderr: '',
    stdout: JSON.stringify({ success: true, data: { enabled: true, port, connected: false, screencasting: false } }),
});
const enableOk = (port: number) => ({
    success: true,
    exitCode: 0,
    stderr: '',
    stdout: JSON.stringify({ success: true, data: { port } }),
});

const disableCalls = () => shell.mock.calls.filter(([, command]) => String(command).includes('stream disable'));

async function mountAndAttach(): Promise<ReturnType<typeof TestRenderer.create>> {
    let renderer!: ReturnType<typeof TestRenderer.create>;
    await TestRenderer.act(async () => {
        renderer = TestRenderer.create(React.createElement(TakeoverScreen));
    });
    // Attached: the resolved port was tunnelled and the socket opened.
    await TestRenderer.act(async () => {
        await vi.waitFor(() => expect(FakeSocket.instances.length).toBe(1));
    });
    return renderer;
}

describe('takeover stream ownership', () => {
    beforeEach(() => {
        shell.mockReset();
        FakeSocket.instances = [];
        vi.stubGlobal('WebSocket', FakeSocket);
        shell.mockImplementation(async (_machineId: string, command: string) => {
            if (command.includes('stream enable')) return alreadyEnabled;
            if (command.includes('stream status')) return statusBound(42249);
            return { success: true, exitCode: 0, stderr: '', stdout: '' };
        });
    });
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('a passive reattach leaves the shared stream running on exit', async () => {
        const renderer = await mountAndAttach();
        expect(shell.mock.calls.some(([, command]) => String(command).includes('stream status'))).toBe(true);
        await TestRenderer.act(async () => {
            renderer.unmount();
        });
        expect(disableCalls()).toEqual([]);
    });

    it('a stream this screen enabled itself is disabled on exit', async () => {
        shell.mockImplementation(async (_machineId: string, command: string) => {
            if (command.includes('stream enable')) return enableOk(41111);
            return { success: true, exitCode: 0, stderr: '', stdout: '' };
        });
        const renderer = await mountAndAttach();
        await TestRenderer.act(async () => {
            renderer.unmount();
        });
        expect(disableCalls()).toEqual([expect.arrayContaining([expect.anything(), expect.stringContaining('agent-browser stream disable')])]);
    });
});
