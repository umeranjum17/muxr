import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import React from 'react';
import TestRenderer from 'react-test-renderer';
import { startFakeSandboxServer, type SandboxServer } from '@byokit/cloud/testing';

// The Boat account step on the real screen, against byokit's fake Boat sign-in server through the real claim().
// The only stand-in is the person: Boat keeps answering "pending" until they open the page the screen offers.
const lab = vi.hoisted(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    return { approved: false, opened: [] as string[], secrets: new Map<string, string>() };
});

const theme = { colors: { status: {}, button: { primary: {}, secondary: {}, quiet: {} } } };
vi.mock('react-native', () => ({
    Platform: { OS: 'android' },
    View: 'View',
    Text: 'Text',
    TextInput: 'TextInput',
    Pressable: 'Pressable',
    ScrollView: 'ScrollView',
    ActivityIndicator: 'ActivityIndicator',
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
    },
}));

let server: SandboxServer;
let current: TestRenderer.ReactTestInstance;
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

function texts(root: TestRenderer.ReactTestInstance): string[] {
    return root.findAllByType('Text' as never).map((node) => [node.props.children].flat().filter((c) => typeof c === 'string').join(''));
}

function button(root: TestRenderer.ReactTestInstance, label: string) {
    return root.findAll((node) => (node.type as unknown) === 'Pressable' && node.props.accessibilityLabel === label)[0];
}

async function until(check: () => boolean, what: string) {
    for (let i = 0; i < 200 && !check(); i += 1) await TestRenderer.act(() => new Promise((resolve) => realSetTimeout(resolve, 10)));
    if (!check()) throw new Error(`never saw ${what}: ${JSON.stringify(texts(current))}`);
}

it('signs in to Boat once the person opens the page, and gives up with a retry after ten minutes', async () => {
    let renderer!: TestRenderer.ReactTestRenderer;
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
        await TestRenderer.act(() => vi.advanceTimersByTimeAsync(10 * 60_000));
        await until(() => !texts(again).includes('Waiting for Boat…'), 'the wait to end');
        expect(texts(again)).toContain('Boat did not finish signing in within 10 minutes. Try again.');
        expect(button(again, 'Try again')).toBeDefined();
        expect(lab.secrets.has('muxr.cloud.boat-key.v1')).toBe(false);
        TestRenderer.act(() => renderer.unmount());
    } finally {
        vi.useRealTimers();
    }
});
