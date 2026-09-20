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
// Text passes its children through so tests can assert what the screen shows.
vi.mock('@/components/StyledText', () => ({ Text: (props: { children?: React.ReactNode }) => React.createElement('Text', props) }));
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
vi.mock('expo-clipboard', () => ({ setStringAsync: vi.fn(async () => {}) }));
vi.mock('@/preview', () => ({
    attachPreviewTunnel: vi.fn(async () => ({ hostname: 'tunnel.test', port: 1234, close: vi.fn() })),
}));

import { setStringAsync } from 'expo-clipboard';
import TakeoverScreen from '../app/(app)/session/[id]/takeover';

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
    // A live browser sits behind the reattached stream; `connected: false`
    // would now (truthfully) resolve as no-browser instead of attaching.
    stdout: JSON.stringify({ success: true, data: { enabled: true, port, connected: true, screencasting: false } }),
});
const statusBrowserless = (port: number) => ({
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

// Sibling specs hold the renderer as `any`: the ambient shim types
// ReactTestRenderer.root as unknown on purpose.
const rendersText = (renderer: any, fragment: string): boolean =>
    renderer.root.findAll((node: any) => typeof node.props.children === 'string' && node.props.children.includes(fragment)).length > 0;

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

    it('Open one launches the shared browser and attaches to its live stream', async () => {
        // First entry lands on a browserless bound stream, the 0.35.1 birth state.
        let browserRunning = false;
        shell.mockImplementation(async (_machineId: string, command: string) => {
            if (command === 'agent-browser open') {
                browserRunning = true;
                return { success: true, exitCode: 0, stderr: '', stdout: '' };
            }
            if (command.includes('stream enable')) return alreadyEnabled;
            if (command.includes('stream status')) return browserRunning ? statusBound(42249) : statusBrowserless(42249);
            return { success: true, exitCode: 0, stderr: '', stdout: '' };
        });
        let renderer: any;
        await TestRenderer.act(async () => {
            renderer = TestRenderer.create(React.createElement(TakeoverScreen));
        });
        await TestRenderer.act(async () => {
            await vi.waitFor(() => expect(rendersText(renderer, "hasn't opened a browser")).toBe(true));
        });
        expect(rendersText(renderer, 'Open one')).toBe(true);
        // The browserless bound port must not attach: no socket, no dead stream.
        expect(FakeSocket.instances).toEqual([]);

        const openOne = renderer.root.findByProps({ accessibilityRole: 'button', accessibilityLabel: 'Open one' });
        await TestRenderer.act(async () => {
            openOne.props.onPress();
            await vi.waitFor(() => expect(shell.mock.calls.some(([, command]) => command === 'agent-browser open')).toBe(true));
        });
        await TestRenderer.act(async () => {
            await vi.waitFor(() => expect(FakeSocket.instances.length).toBe(1));
        });
        await TestRenderer.act(async () => {
            FakeSocket.instances[0].onmessage?.({ data: JSON.stringify({ type: 'frame', data: 'ZmFrZWpwZWc=', metadata: { deviceWidth: 390, deviceHeight: 844, pageScaleFactor: 1 } }) });
        });

        // Live: the shared page is on the phone and the shared stream stays up.
        expect(renderer.root.findByProps({ accessibilityLabel: "The agent's browser page" })).toBeTruthy();
        expect(renderer.root.findByProps({ resizeMode: 'contain' }).props.source.uri).toBe('data:image/jpeg;base64,ZmFrZWpwZWc=');
        expect(disableCalls()).toEqual([]);
    });

    it('a driverless machine shows the install command and Copy command copies it', async () => {
        // exit 127: the computer has no agent-browser, so there is no browser
        // journey at all — the screen must offer the once-only install.
        shell.mockImplementation(async (_machineId: string, command: string) => {
            if (command.includes('stream enable')) return { success: false, exitCode: 127, stderr: 'bash: agent-browser: command not found', stdout: '' };
            return { success: true, exitCode: 0, stderr: '', stdout: '' };
        });
        let renderer: any;
        await TestRenderer.act(async () => {
            renderer = TestRenderer.create(React.createElement(TakeoverScreen));
        });
        await TestRenderer.act(async () => {
            await vi.waitFor(() => expect(rendersText(renderer, 'npm install -g agent-browser && agent-browser install --with-deps')).toBe(true));
        });
        // Nothing to attach to, and nothing of the shared stream to tear down.
        expect(FakeSocket.instances).toEqual([]);

        const copy = renderer.root.findByProps({ accessibilityRole: 'button', accessibilityLabel: 'browser.copyCommand' });
        await TestRenderer.act(async () => {
            copy.props.onPress();
            await vi.waitFor(() => expect(setStringAsync).toHaveBeenLastCalledWith('npm install -g agent-browser && agent-browser install --with-deps'));
        });
        expect(renderer.root.findByProps({ accessibilityLabel: 'browser.copied' })).toBeTruthy();
    });

    it('a real missing-browser open failure shows the install command, not a dead button', async () => {
        // The exact output the installed 0.35.1 binary prints for `open` on a
        // machine with no browser (reproduced live in a chromeless container).
        const realOpenFailure = [
            '✗ Chrome not found. Checked:',
            '  - agent-browser cache: /home/dev/.agent-browser/browsers',
            '  - System Chrome installations',
            '  - Puppeteer browser cache',
            '  - Playwright browser cache',
            'Run `agent-browser install` to download Chrome, or use --executable-path.',
        ].join('\n');
        shell.mockImplementation(async (_machineId: string, command: string) => {
            if (command === 'agent-browser open') return { success: false, exitCode: 1, stderr: realOpenFailure, stdout: '' };
            if (command.includes('stream enable')) return alreadyEnabled;
            if (command.includes('stream status')) return statusBrowserless(42249);
            return { success: true, exitCode: 0, stderr: '', stdout: '' };
        });
        let renderer: any;
        await TestRenderer.act(async () => {
            renderer = TestRenderer.create(React.createElement(TakeoverScreen));
        });
        await TestRenderer.act(async () => {
            await vi.waitFor(() => expect(rendersText(renderer, "hasn't opened a browser")).toBe(true));
        });
        const openOne = renderer.root.findByProps({ accessibilityRole: 'button', accessibilityLabel: 'Open one' });
        await TestRenderer.act(async () => {
            openOne.props.onPress();
            await vi.waitFor(() => expect(shell.mock.calls.some(([, command]) => command === 'agent-browser open')).toBe(true));
        });
        await TestRenderer.act(async () => {
            await vi.waitFor(() => expect(rendersText(renderer, 'agent-browser install --with-deps')).toBe(true));
        });
        // The fix is the once-only install, copied verbatim — never a silent
        // download here, never a Try-again that fails the same way again.
        const copy = renderer.root.findByProps({ accessibilityRole: 'button', accessibilityLabel: 'browser.copyCommand' });
        await TestRenderer.act(async () => {
            copy.props.onPress();
            await vi.waitFor(() => expect(setStringAsync).toHaveBeenLastCalledWith('agent-browser install --with-deps'));
        });
        expect(renderer.root.findByProps({ accessibilityLabel: 'browser.copied' })).toBeTruthy();
        expect(FakeSocket.instances).toEqual([]);
        expect(disableCalls()).toEqual([]);
    });
});
