import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import React from 'react';
import TestRenderer from 'react-test-renderer';
import { startFakeSandboxServer, type SandboxServer } from '@byokit/cloud/testing';

// The Boat account step and the tailnet join on the real screen, against byokit's fake Boat server through the real
// claim() and setup(). The stand-ins are the person, who approves whatever page opens in their browser, and Tailscale
// on the machine, which waits for a login until that sign-in page is opened.
const lab = vi.hoisted(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    return {
        approved: false, opened: [] as string[], secrets: new Map<string, string>(),
        tailscale: 'NeedsLogin', appState: 'active', appStateListeners: [] as (() => void)[],
    };
});
const TAILSCALE_LOGIN = 'https://login.tailscale.com/a/umer-cloud';

const theme = { colors: { status: {}, button: { primary: {}, secondary: {}, quiet: {} } } };
vi.mock('react-native', () => ({
    Platform: { OS: 'android' },
    View: 'View',
    Text: 'Text',
    TextInput: 'TextInput',
    Pressable: 'Pressable',
    ScrollView: 'ScrollView',
    ActivityIndicator: 'ActivityIndicator',
    AppState: {
        get currentState() { return lab.appState; },
        addEventListener: (_type: string, listener: () => void) => {
            lab.appStateListeners.push(listener);
            return { remove: () => { lab.appStateListeners = lab.appStateListeners.filter((l) => l !== listener); } };
        },
    },
}));
vi.mock('react-native-unistyles', () => ({
    StyleSheet: { create: (styles: (theme: unknown) => unknown) => styles(theme) },
    useUnistyles: () => ({ theme }),
}));
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0 }) }));
vi.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));
const router = { replace: vi.fn() };
vi.mock('expo-router', () => ({ useRouter: () => router }));
vi.mock('@/account/ui', () => ({ useAuth: () => ({}) }));
vi.mock('@/pairing', () => ({ pairLinkOffer: vi.fn() }));
vi.mock('@/components/haptics', () => ({ hapticsLight: vi.fn() }));
vi.mock('@/pairing/secrets', () => ({
    getNativeSecret: async (key: string) => lab.secrets.get(key) ?? null,
    setNativeSecret: async (key: string, value: string) => { lab.secrets.set(key, value); },
    deleteNativeSecret: async (key: string) => { lab.secrets.delete(key); },
}));
vi.mock('@/utils/openExternalUrl', () => ({
    openExternalUrl: async (url: string) => {
        lab.opened.push(url);
        lab.approved = true;
        if (url === TAILSCALE_LOGIN) lab.tailscale = 'Running';
    },
}));

let server: SandboxServer;
let current: any;
let CloudSetupScreen: typeof import('./CloudSetupScreen').CloudSetupScreen;
const realFetch = globalThis.fetch;
const realSetTimeout = globalThis.setTimeout;

beforeAll(async () => {
    server = await startFakeSandboxServer();
    process.env.EXPO_PUBLIC_MUXR_BOAT_API = server.url;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        if (!lab.approved && String(input).endsWith('/oauth2/token') && String(init?.body).includes('grant-type%3Aclaim')) {
            return new Response(JSON.stringify({ error: 'authorization_pending' }), { status: 400 });
        }
        return realFetch(input, init);
    }) as typeof fetch;
    ({ CloudSetupScreen } = await import('./CloudSetupScreen'));
});

afterAll(async () => {
    globalThis.fetch = realFetch;
    await server.close();
});

function texts(root: any): string[] {
    return root.findAllByType('Text').map((node: any) => [node.props.children].flat().filter((c) => typeof c === 'string').join(''));
}

function button(root: any, label: string) {
    return root.findAll((node: any) => node.type === 'Pressable' && node.props.accessibilityLabel === label)[0];
}

async function until(check: () => boolean, what: string, tries = 200) {
    for (let i = 0; i < tries && !check(); i += 1) await TestRenderer.act(() => new Promise((resolve) => realSetTimeout(resolve, 10)));
    if (!check()) throw new Error(`never saw ${what}: ${JSON.stringify(texts(current))}`);
}

it('signs in to Boat once the person opens the page, and gives up with a retry after ten minutes', async () => {
    let renderer!: any;
    await TestRenderer.act(async () => { renderer = TestRenderer.create(React.createElement(CloudSetupScreen)); });
    const root = renderer.root;
    current = root;
    TestRenderer.act(() => { root.findByType('TextInput' as never).props.onChangeText('umer@example.com'); });
    TestRenderer.act(() => { button(root, 'Connect Boat account').props.onPress(); });

    // Boat is waiting on the person, so the page link must stay usable while the screen waits.
    await until(() => texts(root).includes('Code · 123456'), 'the Boat code');
    expect(texts(root)).toContain('Waiting for Boat…');
    const signIn = button(root, 'Sign in to Boat');
    expect(signIn.props.disabled).toBeFalsy();
    TestRenderer.act(() => { signIn.props.onPress(); });
    expect(lab.opened).toEqual([expect.stringContaining('/api/boat/agent/identity/claim?claim_attempt_token=')]);

    await until(() => texts(root).includes('Connected'), 'the connected account');
    expect(lab.secrets.get('muxr.cloud.boat-key.v1')).toBe('boat-claimed-key');
    expect(texts(root)).not.toContain('Waiting for Boat…');
    TestRenderer.act(() => renderer.unmount());

    // This time Boat never finishes (it keeps asking muxr to poll more slowly): after ten minutes the screen stops waiting and offers a retry.
    server.scriptClaimPoll(Array(40).fill('slow_down'));
    lab.secrets.clear();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
        await TestRenderer.act(async () => { renderer = TestRenderer.create(React.createElement(CloudSetupScreen)); });
        const again = renderer.root;
        current = again;
        TestRenderer.act(() => { again.findByType('TextInput' as never).props.onChangeText('umer@example.com'); });
        TestRenderer.act(() => { button(again, 'Connect Boat account').props.onPress(); });
        await until(() => texts(again).includes('Code · 123456'), 'the second Boat code');
        await TestRenderer.act(async () => { await vi.advanceTimersByTimeAsync(10 * 60_000); });
        await until(() => !texts(again).includes('Waiting for Boat…'), 'the wait to end');
        expect(texts(again)).toContain('Boat did not finish signing in within 10 minutes. Try again.');
        expect(button(again, 'Try again')).toBeDefined();
        expect(lab.secrets.has('muxr.cloud.boat-key.v1')).toBe(false);
        TestRenderer.act(() => renderer.unmount());
    } finally {
        // Node 22's fetch parks the aborted poll's socket on a (faked) timer; fire it or server.close() never returns.
        await vi.runOnlyPendingTimersAsync();
        vi.useRealTimers();
    }
});

it('opens the Tailscale sign-in page by itself, once muxr is in front, so the new computer joins with no tap in muxr', async () => {
    // Tailscale on the machine, as `tailscale up --timeout=1s` and `tailscale status --json` answer while it waits for a login.
    const run = server.machine.run.bind(server.machine);
    server.machine.run = (argv, o) => {
        const ok = (stdout = '') => ({ code: 0, stdout, stderr: '', timedOut: false });
        if (argv[0] === 'sh' && argv[1] === '-c' && argv[2]?.includes('tailscaled')) return ok();
        if (argv[0] === 'systemctl' && argv.includes('tailscaled')) return ok();
        if (argv[0] === 'tailscale' && argv[1] === 'up') return { code: 1, stdout: '', stderr: `\nTo authenticate, visit:\n\n\t${TAILSCALE_LOGIN}\n\ntimeout waiting for login\n`, timedOut: false };
        if (argv[0] === 'tailscale' && argv[1] === 'status') {
            return ok(JSON.stringify({ BackendState: lab.tailscale, AuthURL: lab.tailscale === 'NeedsLogin' ? TAILSCALE_LOGIN : '', Self: { DNSName: 'muxr-cloud.umer.ts.net.' } }));
        }
        if (argv[0] === 'tailscale' && argv[1] === 'serve') return ok(argv[2] === 'status' ? JSON.stringify({ TCP: { 8792: { TCPForward: '127.0.0.1:8792' } } }) : '');
        // Past the join the test is done: muxr's own set-up stops the run here.
        if (argv.includes('self-host')) return { code: 1, stdout: '', stderr: 'Umer stopped here', timedOut: false };
        return run(argv, o);
    };
    lab.opened = [];
    lab.secrets.clear();
    lab.secrets.set('muxr.cloud.boat-key.v1', 'test-key');
    // The person switched away while the computer was being made: Android would start no browser for muxr now.
    lab.appState = 'background';

    let renderer!: any;
    await TestRenderer.act(async () => { renderer = TestRenderer.create(React.createElement(CloudSetupScreen)); });
    const root = renderer.root;
    current = root;
    await until(() => button(root, 'Create cloud computer') !== undefined, 'the size step');
    TestRenderer.act(() => { button(root, 'Create cloud computer').props.onPress(); });

    await until(() => texts(root).includes('Approve your cloud computer on the sign-in page on your phone.'), 'the Tailscale sign-in step', 1_000);
    expect(lab.opened).toEqual([]);
    lab.appState = 'active';
    TestRenderer.act(() => { for (const listener of [...lab.appStateListeners]) listener(); });
    expect(lab.opened).toEqual([TAILSCALE_LOGIN]);

    await until(() => texts(root).some((t) => t.startsWith('muxr could not set itself up there')), 'the join to finish', 1_000);
    expect(texts(root)).toContain('muxr could not set itself up there: Umer stopped here');
    expect(lab.opened).toEqual([TAILSCALE_LOGIN]);
    expect(lab.appStateListeners).toEqual([]);
    TestRenderer.act(() => renderer.unmount());
});
