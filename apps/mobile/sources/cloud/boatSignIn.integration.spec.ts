import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import React from 'react';
import TestRenderer from 'react-test-renderer';
import { createHash } from 'node:crypto';
import { startFakeSandboxServer, type SandboxServer } from '@byokit/cloud/testing';

// The Boat account step and the SSH route to a new computer on the real screen, against byokit's fake Boat server
// through the real claim() and setup(). The stand-ins are the person, who approves whatever page opens in their
// browser; Boat's SSH key route, which the fake server lacks; the phone's SSH module; and the pairing kit.
const lab = vi.hoisted(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    return {
        approved: false, opened: [] as string[], secrets: new Map<string, string>(), storage: new Map<string, string>(),
        authorized: [] as string[], tunnels: [] as { host: string; port: number; username: string; knownHostKey?: string; remotePort: number }[],
        logins: [] as string[], pairings: [] as number[], redials: [] as unknown[],
    };
});
// Boat's answer for the new computer: its address and host key (a fixed Ed25519 key, SHA256:qF1d…).
const HOST_KEY = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl';
const HOST_FINGERPRINT = `SHA256:${createHash('sha256').update(Buffer.from(HOST_KEY.split(' ')[1], 'base64')).digest('base64').replace(/=+$/, '')}`;

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
vi.mock('@react-native-async-storage/async-storage', () => ({
    default: { getItem: async (key: string) => lab.storage.get(key) ?? null, setItem: async (key: string, value: string) => { lab.storage.set(key, value); } },
}));
vi.mock('expo-crypto', async () => {
    const crypto = await import('node:crypto');
    return {
        CryptoDigestAlgorithm: { SHA256: 'SHA-256' },
        digest: async (_algorithm: string, data: Uint8Array) => new Uint8Array(crypto.createHash('sha256').update(data).digest()),
        getRandomBytes: (length: number) => new Uint8Array(crypto.randomBytes(length)),
    };
});
// The phone's SSH module: the server shows Boat's host key, and lets in only a key Boat authorized.
vi.mock('../../modules/ssh-tunnel', async () => {
    const { sshPublicKeyFromPrivate } = await import('@/connection/sshPublicKey');
    class SshTunnelError extends Error {
        constructor(readonly code: string, message: string) { super(message); }
        static from(error: unknown) { return error instanceof SshTunnelError ? error : new SshTunnelError('ssh-unreachable', String(error)); }
    }
    const login = async (config: { privateKey?: string; knownHostKey?: string }) => {
        if (config.knownHostKey !== HOST_FINGERPRINT) throw new SshTunnelError('ssh-host-key', 'host key mismatch');
        const key = config.privateKey === undefined ? undefined : await sshPublicKeyFromPrivate(config.privateKey);
        if (key === undefined || !lab.authorized.some((line) => line.startsWith(`${key.publicKey} `))) throw new SshTunnelError('ssh-auth', 'refused');
        lab.logins.push(key.publicKey);
        return { hostKey: HOST_FINGERPRINT };
    };
    return {
        isSshTunnelSupported: () => true,
        inspectSshHostKey: async () => HOST_FINGERPRINT,
        verifySshCredentials: login,
        openSshTunnel: async (config: any) => {
            await login(config);
            lab.tunnels.push({ host: config.host, port: config.port, username: config.username, knownHostKey: config.knownHostKey, remotePort: config.remotePort });
            return { localPort: 41234, hostKey: HOST_FINGERPRINT };
        },
        closeSshTunnel: async () => undefined,
        sshTunnelPort: () => 0,
        SshTunnelError,
    };
});
vi.mock('react-native-unistyles', () => ({
    StyleSheet: { create: (styles: (theme: unknown) => unknown) => styles(theme) },
    useUnistyles: () => ({ theme }),
}));
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0 }) }));
vi.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));
const router = { replace: vi.fn() };
vi.mock('expo-router', () => ({ useRouter: () => router }));
vi.mock('@/account/ui', () => ({ useAuth: () => ({}) }));
// The pairing kit has its own flow tests; here it pairs through whatever tunnel port it is given, as the phone would.
vi.mock('@/pairing', () => ({
    pairLinkOffer: async (offer: string, _auth: unknown, o: { tunnelPort?: number; onWords?: (words: string) => void }) => {
        if (offer !== 'muxr-offer-umer' || o.tunnelPort === undefined) return false;
        lab.pairings.push(o.tunnelPort);
        const { DEFAULT_CONNECTION, saveConnectionSettings } = await import('@/connection');
        await saveConnectionSettings({ ...DEFAULT_CONNECTION, mode: 'hosted', selfhost: true, machineId: 'umer-cloud', relayUrl: 'ws://muxr-cloud.ts.net:8792' });
        o.onWords?.('maple river');
        return true;
    },
}));
vi.mock('@/components/haptics', () => ({ hapticsLight: vi.fn() }));
// The sync client redials, and reads the connection route only when it is made.
vi.mock('@/catalog/sync', () => ({
    syncReconnect: async () => { lab.redials.push((await import('@/connection')).getCachedConnectionSettings().ssh); },
}));
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
        if (/\/sandboxes\/[^/]+\/sshkey$/.test(String(input)) && init?.method === 'POST') {
            if (new Headers(init.headers).get('authorization') !== 'Bearer test-key') return new Response('{}', { status: 401 });
            lab.authorized.push(JSON.parse(String(init.body)).key);
            return new Response(JSON.stringify({ hostKey: HOST_KEY, sshEndpoint: '203.0.113.7:22', sshUser: 'user' }), { status: 200 });
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

it('reaches a new cloud computer over SSH with a key this phone made, pairs through that tunnel and joins no tailnet', async () => {
    const run = server.machine.run.bind(server.machine);
    const outbox = '/home/user/muxr/.byokit/outbox';
    const commands: (readonly string[])[] = [];
    server.machine.run = (argv, o) => {
        const ok = (stdout = '') => ({ code: 0, stdout, stderr: '', timedOut: false });
        commands.push(argv);
        if (argv.includes('self-host')) return ok('Configured');
        // `muxr pair --handoff` writes its offer, then reads the two words the phone delivers.
        if (argv.includes('--handoff')) {
            server.machine.writeFile(`${outbox}/muxr-pair-1.json`, new TextEncoder().encode(JSON.stringify({ offer: 'muxr-offer-umer', wordsFile: 'muxr-words-1' })), 0o600, 'user');
            return ok();
        }
        return run(argv, o);
    };
    lab.opened = [];
    lab.secrets.clear();
    lab.secrets.set('muxr.cloud.boat-key.v1', 'test-key');

    let renderer!: any;
    await TestRenderer.act(async () => { renderer = TestRenderer.create(React.createElement(CloudSetupScreen)); });
    const root = renderer.root;
    current = root;
    await until(() => button(root, 'Create cloud computer') !== undefined, 'the size step');
    expect(texts(root)).toContain('Private connection');
    TestRenderer.act(() => { button(root, 'Create cloud computer').props.onPress(); });
    await until(() => router.replace.mock.calls.length > 0, 'Home after pairing', 2_000);

    // Boat authorized one new Ed25519 key, and the phone signed in with exactly that key, to the host key Boat gave.
    expect(lab.authorized).toEqual([expect.stringMatching(/^ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI[A-Za-z0-9+/]+ muxr phone$/)]);
    expect(lab.logins.length).toBeGreaterThan(0);
    expect(lab.logins.every((key) => lab.authorized[0].startsWith(`${key} `))).toBe(true);
    expect(lab.tunnels).toEqual([{ host: '203.0.113.7', port: 22, username: 'user', knownHostKey: HOST_FINGERPRINT, remotePort: 8792 }]);
    expect(lab.pairings).toEqual([41234]);
    expect(new TextDecoder().decode(server.machine.files.get('/home/user/muxr/.byokit/inbox/muxr-words-1')?.bytes)).toBe('maple river');

    // The phone keeps that route: the key in the secure store, the pinned target and the relay on the machine's loopback.
    const { getCachedConnectionSettings } = await import('@/connection');
    expect(getCachedConnectionSettings()).toMatchObject({ machineId: 'umer-cloud', relayUrl: 'ws://127.0.0.1:8792', ssh: { host: '203.0.113.7', port: 22, username: 'user', relayPort: 8792, hostKey: HOST_FINGERPRINT } });
    // Pairing started the sync client on the relay's advertised name; it redials once the SSH route is saved.
    expect(lab.redials).toEqual([expect.objectContaining({ host: '203.0.113.7', hostKey: HOST_FINGERPRINT })]);
    expect(JSON.parse(lab.secrets.get('muxr.ssh.credential.v1.umer-cloud') ?? '{}').privateKey).toMatch(/^-----BEGIN OPENSSH PRIVATE KEY-----\n/);

    // No tailnet anywhere: no sign-in page, no tailscale command, no tailnet name handed to muxr.
    expect(lab.opened).toEqual([]);
    expect(commands.some((argv) => argv.some((a) => a.includes('tailscale')))).toBe(false);
    expect(commands.find((argv) => argv.includes('self-host'))).toEqual(expect.arrayContaining(['--loopback', '--advertise', 'ws://muxr-cloud.ts.net:8792']));
    TestRenderer.act(() => renderer.unmount());
});
