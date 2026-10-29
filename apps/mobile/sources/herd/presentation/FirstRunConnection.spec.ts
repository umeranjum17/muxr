import { beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import TestRenderer from 'react-test-renderer';

let platformOs: 'android' | 'web' = 'android';
let searchParams: { step?: string } = {};
const routerPush = vi.fn();
const scanQr = vi.fn(async () => undefined);
const dismissScanner = vi.fn(async () => undefined);
const pairingAlert = vi.fn();
let clipboardText = '';
let scanOnScanned: ((event: { data: string }) => void) | undefined;

const theme = vi.hoisted(() => ({
    colors: {
        text: '#000',
        textSecondary: '#555',
        surfaceHigh: '#eee',
        surfaceHighest: '#ddd',
        surface: '#fff',
        divider: '#ccc',
        accentSubtle: '#ddf',
        accent: '#00f',
        button: { primary: { background: '#00f' }, secondary: { background: '#eee' }, quiet: { background: 'transparent' } },
    },
}));

vi.mock('react-native', () => ({
    AppState: { currentState: 'active' },
    Share: { share: vi.fn(async () => undefined) },
    Linking: { openURL: vi.fn(async () => undefined) },
    Platform: { get OS() { return platformOs; } },
    useWindowDimensions: () => ({ fontScale: 1, width: 390 }),
    View: 'View',
    Text: 'Text',
    TextInput: 'TextInput',
    Pressable: 'Pressable',
    ScrollView: 'ScrollView',
    ActivityIndicator: 'ActivityIndicator',
}));
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0 }) }));
vi.mock('@/cloud', () => ({ BOAT_FROM_PER_HOUR: 0.018 }));
vi.mock('react-native-unistyles', () => ({
    StyleSheet: { create: (styles: (theme: unknown) => unknown) => styles(theme) },
    useUnistyles: () => ({ theme }),
}));
vi.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));
vi.mock('expo-router', () => ({ useRouter: () => ({ push: routerPush }), useLocalSearchParams: () => searchParams }));
vi.mock('@/pairing', async () => {
    const { pairingDeviceNoun, usePairQrScannerAvailable, useHostedPairing, usePairQrScanner } = await import('@/pairing/application/usePairing');
    return { pairingDeviceNoun, usePairQrScannerAvailable, useHostedPairing, usePairQrScanner };
});
vi.mock('expo-camera', () => ({
    CameraView: {
        isModernBarcodeScannerAvailable: true,
        onModernBarcodeScanned: (onScanned: (event: { data: string }) => void) => {
            scanOnScanned = onScanned;
            return { remove: vi.fn() };
        },
        launchScanner: () => scanQr(),
        dismissScanner: () => dismissScanner(),
    },
}));
vi.mock('expo-device', () => ({ isDevice: true }));
vi.mock('@/pairing/application/useCheckCameraPermissions', () => ({ useCheckScannerPermissions: () => async () => true }));
vi.mock('@/account/ui', () => ({ useAuth: () => ({}) }));
vi.mock('@/pairing/application/linkPairing', () => ({ linkPairMachineName: vi.fn(), pairOverLink: vi.fn() }));
vi.mock('@/pairing/application/PairMachine', () => ({ pairMachine: vi.fn() }));
vi.mock('@/pairing/infrastructure/pairingPlatform', () => ({
    pairingDeviceKind: () => platformOs === 'web' ? 'browser' : 'phone',
    pairingDeviceNoun: () => platformOs === 'web' ? 'browser' : 'phone',
}));
vi.mock('@/connection', () => ({ sshTunnelAvailable: () => platformOs === 'android' }));
vi.mock('@/modal', () => ({ Modal: { alert: (...args: unknown[]) => pairingAlert(...args) } }));
vi.mock('@/components/haptics', () => ({ hapticsLight: vi.fn() }));
vi.mock('expo-clipboard', () => ({ setStringAsync: vi.fn(async () => true), getStringAsync: async () => clipboardText }));
vi.mock('@/catalog', () => ({ loadAppConfig: () => ({ publicBaseUrl: 'https://trymuxr.example' }) }));
vi.mock('@/utils/openExternalUrl', () => ({ openExternalUrl: vi.fn() }));

import { FirstRunConnection } from './FirstRunConnection';
import { MyComputerSetup } from './MyComputerSetup';
import { offerText } from '@byokit/pair';

function freshOffer(): string {
    return offerText({ v: 1, host: Buffer.alloc(32, 1).toString('base64url'), ticket: Buffer.alloc(16, 2).toString('base64url'),
        urls: ['wss://relay.example.test/link/v1/host'], expires: Date.now() + 120_000, name: 'Desk' });
}

function expiredOffer(): string {
    return offerText({ v: 1, host: Buffer.alloc(32, 1).toString('base64url'), ticket: Buffer.alloc(16, 2).toString('base64url'),
        urls: ['wss://relay.example.test/link/v1/host'], expires: Date.now() - 1000, name: 'Desk' });
}

function texts(root: any): string[] {
    return root.findAllByType('Text').map((node: any) => {
        const children = node.props.children;
        return (Array.isArray(children) ? children : [children]).filter((child) => typeof child === 'string').join('');
    });
}

function buttons(root: any): any[] {
    return root.findAllByType('Pressable');
}

function press(root: any, label: string): void {
    const target = buttons(root).find((node) => node.props.accessibilityLabel === label || node.props.accessibilityLabel?.startsWith(`${label}. `));
    if (target === undefined) throw new Error(`no button labelled ${label}`);
    TestRenderer.act(() => { target.props.onPress(); });
}

function typeLink(root: any, value: string): void {
    const field = root.findByType('TextInput');
    TestRenderer.act(() => { field.props.onChangeText(value); });
}

describe('two-door first run', () => {
    beforeEach(() => {
        platformOs = 'android';
        searchParams = {};
        routerPush.mockClear();
        scanQr.mockClear();
        dismissScanner.mockClear();
        pairingAlert.mockClear();
    });

    it('offers two equal doors and SSH as a link, walks My computer from Get ready to Pair, and validates pasted input like a scan', async () => {
        let renderer: any;
        TestRenderer.act(() => { renderer = TestRenderer.create(React.createElement(FirstRunConnection)); });
        let visible = texts(renderer.root);
        expect(visible).toContain('Connect a machine');
        // Each door says what it is, how long it takes, and what it needs or costs.
        expect(visible).toContain('My computer');
        expect(visible).toContain('About 4–5 min · about 1 min if muxr already runs');
        expect(visible).toContain('Needs Tailscale on both ends');
        expect(visible).toContain('Cloud machine · Boat');
        expect(visible).toContain('About 4–6 min with a Boat account');
        expect(visible).toContain('Paid to Boat, from $0.018 an hour');
        expect(visible).toContain('Any server over SSH · 3–7 min');
        expect(visible).toContain('Encrypted after verified pairing. No new muxr account.');
        expect(visible.some((text) => text.includes('phone'))).toBe(false);
        press(renderer.root, 'My computer');
        expect(routerPush).toHaveBeenCalledWith('/my-computer');
        press(renderer.root, 'Cloud machine · Boat');
        expect(routerPush).toHaveBeenCalledWith('/cloud-computer');
        // SSH opens the existing SSH flow unchanged.
        press(renderer.root, 'Any server over SSH. 3 to 7 minutes.');
        expect(routerPush).toHaveBeenCalledWith('/pair?route=ssh');
        routerPush.mockClear();
        TestRenderer.act(() => { renderer.unmount(); });

        // Get ready: Tailscale, then muxr on the computer, each with its time.
        TestRenderer.act(() => { renderer = TestRenderer.create(React.createElement(MyComputerSetup)); });
        visible = texts(renderer.root);
        const order = ['Step 1 of 3', 'Get ready', '1 · Tailscale on both ends', 'about 2 min', '2 · muxr on the computer', 'about 1–2 min'].map((title) => visible.indexOf(title));
        expect(order.every((index, step) => index >= 0 && (step === 0 || index > order[step - 1]!))).toBe(true);
        press(renderer.root, 'Get the desktop app. Open its download link on your computer.');
        expect(routerPush).toHaveBeenCalledWith('/add-computer');
        press(renderer.root, 'Next: pair');
        expect(routerPush).toHaveBeenCalledWith('/my-computer?step=pair');
        routerPush.mockClear();
        TestRenderer.act(() => { renderer.unmount(); });

        searchParams = { step: 'pair' };
        TestRenderer.act(() => { renderer = TestRenderer.create(React.createElement(MyComputerSetup)); });
        visible = texts(renderer.root);
        expect(visible).toContain('Step 2 of 3');
        expect(visible).toContain('Pair with your computer');
        expect(renderer.root.findByType('TextInput').props.accessibilityLabel).toBe('Private link or pairing code');
        expect(visible).toContain('Then check two words');
        expect(visible).toContain('Example words');
        expect(visible).toContain('Next · Start an agent');
        expect(renderer.root.findByType('TextInput').props.placeholder).toBe('Paste link');
        // No raw backticks or kit jargon in user-visible copy.
        for (const text of visible) {
            expect(text).not.toContain('`');
            expect(text).not.toContain('byokit-link');
        }
        // An empty field pastes: nothing on the clipboard never routes, the same alert a bad scan shows.
        press(renderer.root, 'Paste a link');
        await TestRenderer.act(async () => {});
        expect(pairingAlert).toHaveBeenCalledWith('Pairing code not usable', "That isn't a muxr pairing string. Open muxr on your computer, or run muxr pair, for a new one.");
        expect(routerPush).not.toHaveBeenCalled();
        pairingAlert.mockClear();
        // The computer's one link (`muxr link`) on the clipboard opens the pair screen in one tap.
        typeLink(renderer.root, '');
        clipboardText = `http://desk.tail1234.ts.net:8792/join#${'a'.repeat(43)}`;
        press(renderer.root, 'Paste a link');
        await TestRenderer.act(async () => {});
        expect(pairingAlert).not.toHaveBeenCalled();
        expect(routerPush).toHaveBeenCalledWith({ pathname: '/pair', params: { offer: clipboardText } });
        routerPush.mockClear();
        // Cut short, it says so instead of pairing.
        typeLink(renderer.root, '');
        clipboardText = `http://desk.tail1234.ts.net:8792/join#${'a'.repeat(20)}`;
        press(renderer.root, 'Paste a link');
        await TestRenderer.act(async () => {});
        expect(pairingAlert).toHaveBeenCalledWith('Pairing code not usable', expect.stringContaining('cut off'));
        expect(routerPush).not.toHaveBeenCalled();
        pairingAlert.mockClear();
        // A legacy code names the old version, like a scan does.
        typeLink(renderer.root, 'wss://relay?pair=abc');
        press(renderer.root, 'Connect');
        await TestRenderer.act(async () => {});
        expect(pairingAlert).toHaveBeenCalledWith('Pairing code not usable', expect.stringContaining('muxr 0.2.0 or older'));
        expect(pairingAlert).toHaveBeenCalledTimes(1);
        expect(routerPush).not.toHaveBeenCalled();
        pairingAlert.mockClear();
        // A cut-off code names the cut, never the version.
        typeLink(renderer.root, 'byokit-link:1:not-valid!!');
        press(renderer.root, 'Connect');
        await TestRenderer.act(async () => {});
        expect(routerPush).not.toHaveBeenCalled();
        expect(pairingAlert).toHaveBeenCalledWith('Pairing code not usable', expect.stringContaining('cut off'));
        expect(pairingAlert).toHaveBeenCalledTimes(1);
        pairingAlert.mockClear();
        // An expired pasted code opens the pair screen's expired state.
        const expired = expiredOffer();
        typeLink(renderer.root, expired);
        press(renderer.root, 'Connect');
        await TestRenderer.act(async () => {});
        expect(pairingAlert).not.toHaveBeenCalled();
        expect(routerPush).toHaveBeenCalledWith({ pathname: '/pair', params: { offer: expired } });
        routerPush.mockClear();
        // A wrapped valid offer still pairs: surrounding whitespace is trimmed.
        const whole = freshOffer();
        typeLink(renderer.root, `  ${whole.slice(0, 60)}\n${whole.slice(60)}  `);
        press(renderer.root, 'Connect');
        await TestRenderer.act(async () => {});
        expect(pairingAlert).not.toHaveBeenCalled();
        expect(routerPush).toHaveBeenCalledWith({ pathname: '/pair', params: { offer: whole } });
        routerPush.mockClear();
        // Scan stays one tap away on a device with a camera.
        press(renderer.root, 'Scan the QR');
        await TestRenderer.act(async () => {});
        expect(scanQr).toHaveBeenCalledTimes(1);
        // A cut-off scanned code gets the same single alert and never routes.
        await TestRenderer.act(async () => { scanOnScanned!({ data: 'byokit-link:1:not-valid!!' }); });
        expect(dismissScanner).toHaveBeenCalledTimes(1);
        expect(routerPush).not.toHaveBeenCalled();
        expect(pairingAlert).toHaveBeenCalledWith('Pairing code not usable', expect.stringContaining('cut off'));
        expect(pairingAlert).toHaveBeenCalledTimes(1);
        pairingAlert.mockClear();
        press(renderer.root, 'Scan the QR');
        await TestRenderer.act(async () => {});
        await TestRenderer.act(async () => { scanOnScanned!({ data: whole }); });
        expect(routerPush).toHaveBeenCalledWith({ pathname: '/pair', params: { offer: whole } });
        expect(pairingAlert).not.toHaveBeenCalled();
        routerPush.mockClear();
        TestRenderer.act(() => { renderer.unmount(); });
    });

    it('browser keeps both doors, points cloud setup at the phone app, and pairs by paste only', async () => {
        platformOs = 'web';
        let renderer: any;
        TestRenderer.act(() => { renderer = TestRenderer.create(React.createElement(FirstRunConnection)); });
        let visible = texts(renderer.root);
        expect(visible).toContain('My computer');
        expect(visible).toContain('Cloud machine · Boat');
        expect(visible).toContain('In a browser: set up from the muxr phone app');
        expect(visible).not.toContain('Any server over SSH · 3–7 min');
        TestRenderer.act(() => { renderer.unmount(); });
        // A browser cannot pair with the desktop app, so Get ready points at the command.
        TestRenderer.act(() => { renderer = TestRenderer.create(React.createElement(MyComputerSetup)); });
        expect(buttons(renderer.root).some((node) => node.props.accessibilityLabel?.startsWith('Get the desktop app'))).toBe(false);
        TestRenderer.act(() => { renderer.unmount(); });
        searchParams = { step: 'pair' };
        TestRenderer.act(() => { renderer = TestRenderer.create(React.createElement(MyComputerSetup)); });
        visible = texts(renderer.root);
        expect(visible.some((text) => text.includes('Paste the browser link that muxr link shows on your computer.'))).toBe(true);
        expect(visible.some((text) => text.includes("can't scan"))).toBe(false);
        expect(buttons(renderer.root).some((node) => node.props.accessibilityLabel === 'Scan the QR')).toBe(false);
        const whole = freshOffer();
        typeLink(renderer.root, whole);
        press(renderer.root, 'Connect');
        await TestRenderer.act(async () => {});
        expect(pairingAlert).not.toHaveBeenCalled();
        expect(routerPush).toHaveBeenCalledWith({ pathname: '/pair', params: { offer: whole } });
        expect(scanQr).not.toHaveBeenCalled();
        TestRenderer.act(() => { renderer.unmount(); });
    });
});
