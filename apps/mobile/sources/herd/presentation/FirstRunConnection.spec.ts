import { beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import TestRenderer from 'react-test-renderer';

let platformOs: 'android' | 'web' = 'android';
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
    useWindowDimensions: () => ({ fontScale: 1 }),
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
vi.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));
vi.mock('expo-router', () => ({ useRouter: () => ({ push: routerPush }) }));
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
    const target = buttons(root).find((node) => node.props.accessibilityLabel === label);
    if (target === undefined) throw new Error(`no button labelled ${label}`);
    TestRenderer.act(() => { target.props.onPress(); });
}

function typeLink(root: any, value: string): void {
    const field = root.findByType('TextInput');
    TestRenderer.act(() => { field.props.onChangeText(value); });
}

describe('link-first connect shell', () => {
    beforeEach(() => {
        platformOs = 'android';
        routerPush.mockClear();
        scanQr.mockClear();
        dismissScanner.mockClear();
        pairingAlert.mockClear();
    });

    it('leads with Tailscale then the desktop app, validates pasted input like a scan, keeps SSH and opens cloud setup', async () => {
        let renderer: any;
        TestRenderer.act(() => { renderer = TestRenderer.create(React.createElement(FirstRunConnection)); });
        const visible = texts(renderer.root);
        expect(visible).toContain('Your machine. No new account.');
        expect(visible).toContain('Let’s connect');
        expect(visible).toContain('Use the machine you already have.');
        // Tailscale first, then muxr on the computer, then pairing.
        const order = ['Get Tailscale', 'Get muxr on your computer', 'Pair with your computer'].map((title) => visible.indexOf(title));
        expect(order.every((index, step) => index >= 0 && (step === 0 || index > order[step - 1]!))).toBe(true);
        expect(visible).toContain('Private link or pairing code');
        expect(visible).toContain('Other ways');
        expect(visible).toContain('Cloud computer');
        expect(visible).toContain('Boat · 2–5 min');
        expect(visible).toContain('SSH login');
        expect(visible).toContain('Any server · 3–7 min');
        expect(visible).toContain('Encrypted after verified pairing');
        expect(visible).toContain('Your infrastructure. No muxr-hosted relay.');
        // The link field leads; the setup command stays one tap away under More ways.
        expect(renderer.root.findByType('TextInput').props.placeholder).toBe('Paste link');
        expect(visible.some((text) => text.includes('npm install'))).toBe(false);
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
        // Step 2 hands the desktop app's link over on the Add your computer screen.
        press(renderer.root, 'Get the desktop app. Open its download link on your computer.');
        expect(routerPush).toHaveBeenCalledWith('/add-computer');
        routerPush.mockClear();
        // SSH login opens the existing SSH flow unchanged.
        press(renderer.root, 'SSH login. Any server, 3 to 7 minutes.');
        expect(routerPush).toHaveBeenCalledWith('/pair?route=ssh');
        routerPush.mockClear();
        // Cloud setup is an active first-run entry without changing the existing connect paths.
        const cloud = buttons(renderer.root).find((node) => node.props.accessibilityLabel === 'Add a cloud computer. Boat.');
        expect(cloud).toBeDefined();
        expect(cloud.props.disabled).not.toBe(true);
        press(renderer.root, 'Add a cloud computer. Boat.');
        expect(routerPush).toHaveBeenCalledWith('/cloud-computer');
        routerPush.mockClear();
        // More ways holds the computer setup command and the fallback routes.
        press(renderer.root, 'More ways and timing');
        const expanded = texts(renderer.root);
        expect(expanded).toContain('On your computer');
        expect(expanded.some((text) => text.includes('Tailscale'))).toBe(true);
        TestRenderer.act(() => { renderer.unmount(); });
    });

    it('browser leads with paste, hides scan and SSH, and shows the phone-app cloud instruction', async () => {
        platformOs = 'web';
        let renderer: any;
        TestRenderer.act(() => { renderer = TestRenderer.create(React.createElement(FirstRunConnection)); });
        const visible = texts(renderer.root);
        expect(visible).toContain('Get Tailscale');
        expect(visible).toContain('Pair with your computer');
        expect(visible.some((text) => text.includes('Paste the browser link from muxr on your computer.'))).toBe(true);
        expect(visible.some((text) => text.includes('compare two words before access is granted'))).toBe(true);
        expect(visible).toContain('Cloud computer');
        expect(visible).toContain('Set up from the muxr phone app');
        expect(visible).not.toContain('SSH login');
        // A browser cannot pair with the desktop app, so step 2 points at the command.
        expect(buttons(renderer.root).some((node) => node.props.accessibilityLabel?.startsWith('Get the desktop app'))).toBe(false);
        expect(visible.some((text) => text.includes("can't scan"))).toBe(false);
        expect(buttons(renderer.root).some((node) => node.props.accessibilityLabel === 'Scan the QR')).toBe(false);
        const whole = freshOffer();
        typeLink(renderer.root, whole);
        press(renderer.root, 'Connect');
        await TestRenderer.act(async () => {});
        expect(pairingAlert).not.toHaveBeenCalled();
        expect(routerPush).toHaveBeenCalledWith({ pathname: '/pair', params: { offer: whole } });
        expect(scanQr).not.toHaveBeenCalled();
        press(renderer.root, 'Cloud computer. Set up from the muxr phone app.');
        expect(routerPush).toHaveBeenCalledWith('/cloud-computer');
        TestRenderer.act(() => { renderer.unmount(); });
    });
});
