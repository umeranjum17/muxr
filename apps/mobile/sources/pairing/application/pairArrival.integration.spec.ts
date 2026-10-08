import { expect, it, vi } from 'vitest';
import { hostId, keyPairFrom, offerText, parseOffer, unb64url } from '@byokit/link';
import { linkUrl } from '@byokit/relay/device';

const harness = vi.hoisted(() => ({
    secureValues: new Map<string, string>(),
    asyncValues: new Map<string, string>(),
    claims: 0,
    declined: false,
    authenticated: false,
    initialUrl: null as string | null,
    params: {} as { offer?: string },
    receive: undefined as ((event: { url: string }) => void) | undefined,
    router: { replace: vi.fn(), back: vi.fn() },
}));

vi.mock('react-native', () => ({
    Platform: { OS: 'android' },
    ActivityIndicator: 'ActivityIndicator',
    Pressable: 'Pressable',
    ScrollView: 'ScrollView',
    Text: 'Text',
    TextInput: 'TextInput',
    View: 'View',
}));
vi.mock('react-native-keyboard-controller', () => ({ KeyboardAwareScrollView: 'ScrollView', KeyboardStickyView: 'View' }));
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0 }) }));
vi.mock('react-native-unistyles', () => ({
    StyleSheet: { create: (styles: (theme: unknown) => unknown) => styles({ colors: {
        text: '#000', textSecondary: '#555', textDestructive: '#f00', surface: '#fff',
        surfaceHigh: '#eee', surfaceHighest: '#ddd', divider: '#ccc',
        button: { primary: { background: '#00f', tint: '#fff' } },
    } }) },
}));
vi.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));
vi.mock('expo-clipboard', () => ({ setStringAsync: async () => undefined }));
vi.mock('@/components/haptics', () => ({ hapticsLight: () => undefined }));
vi.mock('@/herd/presentation/FirstRunConnection', () => ({ RouteSwitcher: () => null }));
vi.mock('expo-router', () => ({ useRouter: () => harness.router, useLocalSearchParams: () => harness.params }));
vi.mock('expo-linking', () => ({
    getInitialURL: async () => harness.initialUrl,
    addEventListener: (_type: string, receive: (event: { url: string }) => void) => {
        harness.receive = receive;
        return { remove: () => { harness.receive = undefined; } };
    },
}));
vi.mock('expo-camera', () => ({
    CameraView: { isModernBarcodeScannerAvailable: false },
    useCameraPermissions: () => [{ granted: true }, async () => ({ granted: true })],
}));
vi.mock('expo-device', () => ({ isDevice: true }));
vi.mock('expo-secure-store', () => ({
    getItemAsync: async (key: string) => harness.secureValues.get(key) ?? null,
    setItemAsync: async (key: string, value: string) => { harness.secureValues.set(key, value); },
    deleteItemAsync: async (key: string) => { harness.secureValues.delete(key); },
}));
vi.mock('@react-native-async-storage/async-storage', () => ({
    default: {
        getItem: async (key: string) => harness.asyncValues.get(key) ?? null,
        setItem: async (key: string, value: string) => { harness.asyncValues.set(key, value); },
        removeItem: async (key: string) => { harness.asyncValues.delete(key); },
    },
}));
vi.mock('@/account/ui', async () => {
    const React = await import('react');
    const { TokenStorage } = await import('@/account/infrastructure/tokenStorage');
    return { useAuth: () => {
        const [isAuthenticated, setAuthenticated] = React.useState(harness.authenticated);
        return { isAuthenticated, login: async (token: string, secret: string) => {
            await TokenStorage.setCredentials({ token, secret });
            harness.authenticated = true;
            setAuthenticated(true);
        } };
    } };
});
vi.mock('@/conversation/session', () => ({
    realtimeMachineSwitchGuard: () => ({ allowed: true }),
    stopRealtimeSession: () => undefined,
}));
vi.mock('@/connection', async () => ({
    ...await import('@/connection/connectionSettings'),
    forgetSshCredential: async () => undefined,
    sshTunnelAvailable: () => false,
}));
vi.mock('@/modal', () => ({ Modal: { alert: vi.fn(), confirm: async () => true } }));
vi.mock('@/pairing', async () => ({
    ...await import('./usePairing'),
    ...await import('./pairArrival'),
}));
vi.mock('../infrastructure/linkPairClient', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../infrastructure/linkPairClient')>();
    return {
        ...actual,
        claimLinkPairing: async (
            pending: { scanned: string; secretKey: string; name: string },
            options: { onClaimed?: () => Promise<void>; onProven?: (answer: never) => Promise<void> },
        ) => {
            harness.claims += 1;
            const { PairingNeedsNewCode } = await import('../domain/pairingString');
            if (harness.declined) throw new PairingNeedsNewCode('The computer declined this pairing.');
            const parsed = parseOffer(pending.scanned);
            const key = keyPairFrom(unb64url(pending.secretKey));
            const answer = {
                machineId: `machine-${parsed.ticket}`,
                machineName: parsed.name,
                machineBoxPublicKey: Buffer.from(unb64url(parsed.host)).toString('base64url'),
                relayUrl: parsed.urls[0]?.split('/link/')[0] ?? '',
                deviceId: 'device-test',
                authority: parsed.role ?? 'control',
                expiresAt: Date.now() + 3_600_000,
                linkUrl: parsed.urls[0] ?? '',
            };
            await options.onClaimed?.();
            await options.onProven?.(answer as never);
            return { ...answer, key };
        },
    };
});

const RELAY = 'ws://127.0.0.1:33863';

function machineOffer(seed: number, overrides: { expires?: number; url?: string } = {}): string {
    const hostBytes = Buffer.alloc(32, seed);
    return offerText({
        v: 1, host: hostBytes.toString('base64url'), name: 'Umer-test',
        urls: [overrides.url ?? linkUrl(RELAY, hostId(hostBytes))],
        ticket: Buffer.alloc(16, seed).toString('base64url'),
        expires: overrides.expires ?? Date.now() + 240_000, role: 'control',
    });
}

async function modules() {
    const React = await import('react');
    const { default: renderer } = await import('react-test-renderer');
    const { default: PairScreen } = await import('@/app/(app)/pair');
    const { TokenStorage } = await import('@/account/infrastructure/tokenStorage');
    const connection = await import('@/connection/connectionSettings');
    const pairing = await import('./linkPairing');
    const grants = await import('../infrastructure/grantStore');
    return { React, renderer, PairScreen, TokenStorage, ...connection, ...pairing, ...grants };
}

it('keeps the active pairing through screen recreation and relaunch, but asks before switching', async () => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    let mod = await modules();
    let screen!: import('react-test-renderer').ReactTestRenderer;
    const mount = async () => {
        await mod.renderer.act(async () => { screen = mod.renderer.create(mod.React.createElement(mod.PairScreen)); });
    };
    const unmount = async () => {
        await mod.renderer.act(async () => { screen.unmount(); });
        harness.router.replace.mockClear();
    };
    const pairButtons = () => screen.root.findAll((node) => node.type === 'Pressable' && node.props.accessibilityLabel === 'Pair');
    const pressPair = async () => {
        expect(pairButtons()).toHaveLength(1);
        await mod.renderer.act(async () => { pairButtons()[0]!.props.onPress(); });
    };
    const deliver = async (url: string) => {
        expect(harness.receive).toBeDefined();
        await mod.renderer.act(async () => { harness.receive!({ url }); });
    };
    const expectHome = async (credentials: unknown, machineId: string) => {
        expect(harness.router.replace).toHaveBeenCalledWith('/');
        expect(pairButtons()).toHaveLength(0);
        expect(await mod.TokenStorage.getCredentials()).toEqual(credentials);
        expect((await mod.loadConnectionSettingsAsync()).machineId).toBe(machineId);
        expect(harness.claims).toBe(1);
    };

    const offer = machineOffer(7);
    harness.initialUrl = offer;
    await mount();
    expect(harness.router.replace).not.toHaveBeenCalled();
    await pressPair();
    const credentials = await mod.TokenStorage.getCredentials();
    expect(credentials).not.toBeNull();
    const active = (await mod.listPairedGrants())[0]!;
    expect(harness.claims).toBe(1);
    await unmount();

    harness.params = { offer };
    await mount();
    await expectHome(credentials, active.machineId);
    await unmount();

    vi.resetModules();
    harness.params = {};
    mod = await modules();
    harness.authenticated = (await mod.TokenStorage.getCredentials()) !== null;
    await mount();
    await expectHome(credentials, active.machineId);
    await unmount();

    harness.initialUrl = null;
    await mount();
    await deliver(machineOffer(7, { expires: Date.now() - 60_000 }));
    await expectHome(credentials, active.machineId);
    await unmount();

    await mod.storeGrant({ ...active, linkUrl: undefined });
    harness.initialUrl = offer;
    await mount();
    await expectHome(credentials, active.machineId);
    await unmount();

    harness.initialUrl = null;
    await mount();
    await deliver(machineOffer(7, { url: `${RELAY}/unrelated` }));
    expect(pairButtons()).toHaveLength(1);
    expect(harness.router.replace).not.toHaveBeenCalled();
    await unmount();

    const other = machineOffer(8);
    await mount();
    await deliver(other);
    expect(pairButtons()).toHaveLength(1);
    expect(harness.router.replace).not.toHaveBeenCalled();
    harness.declined = true;
    await pressPair();
    expect(screen.root.findAll((node) => node.type === 'Text' && node.props.accessibilityRole === 'alert')
        .map((node) => node.props.children)).toContain('The computer declined this pairing.');
    expect(harness.router.replace).not.toHaveBeenCalled();
    expect(await mod.TokenStorage.getCredentials()).toEqual(credentials);
    expect(mod.getCachedConnectionSettings().machineId).toBe(active.machineId);
    await unmount();

    harness.declined = false;
    harness.initialUrl = other;
    await mount();
    await pressPair();
    const switchedCredentials = await mod.TokenStorage.getCredentials();
    const switchedSettings = await mod.loadConnectionSettingsAsync();
    expect(switchedSettings.machineId).not.toBe(active.machineId);
    expect(await mod.listPairedGrants()).toHaveLength(2);
    await unmount();

    harness.initialUrl = offer;
    await mount();
    expect(pairButtons()).toHaveLength(1);
    expect(harness.router.replace).not.toHaveBeenCalled();
    expect(await mod.TokenStorage.getCredentials()).toEqual(switchedCredentials);
    expect(mod.getCachedConnectionSettings().machineId).toBe(switchedSettings.machineId);
    expect(harness.claims).toBe(3);
    await unmount();
});
