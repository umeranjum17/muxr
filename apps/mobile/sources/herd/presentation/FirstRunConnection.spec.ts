import { beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import TestRenderer from 'react-test-renderer';

let platformOs: 'android' | 'web' = 'android';
const routerPush = vi.fn();
const scanQr = vi.fn(async () => undefined);
const dismissScanner = vi.fn(async () => undefined);
const pairingAlert = vi.fn();
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
    Platform: { get OS() { return platformOs; } },
    View: 'View',
    Text: 'Text',
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
    const { pairingDeviceNoun, pairQrScannerAvailable, useHostedPairing, usePairQrScanner } = await import('@/pairing/application/usePairing');
    return { pairingDeviceNoun, pairQrScannerAvailable, useHostedPairing, usePairQrScanner };
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
vi.mock('@/modal', () => ({ Modal: { prompt: vi.fn(async () => undefined), alert: (...args: unknown[]) => pairingAlert(...args) } }));
vi.mock('@/components/haptics', () => ({ hapticsLight: vi.fn() }));
vi.mock('expo-clipboard', () => ({ setStringAsync: vi.fn(async () => true) }));
vi.mock('@/catalog', () => ({ loadAppConfig: () => ({}) }));
vi.mock('@/utils/openExternalUrl', () => ({ openExternalUrl: vi.fn() }));

import { FirstRunConnection } from './FirstRunConnection';
import { Modal } from '@/modal';
import { offerText } from '@byokit/link';

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

describe('guided first-connection chooser', () => {
    beforeEach(() => {
        platformOs = 'android';
        routerPush.mockClear();
        scanQr.mockClear();
        dismissScanner.mockClear();
        pairingAlert.mockClear();
    });

    it('opens Scan directly, rejects old codes, routes current offers to consent, and keeps manual and SSH entry visible', async () => {
        let renderer: any;
        TestRenderer.act(() => { renderer = TestRenderer.create(React.createElement(FirstRunConnection)); });
        const visible = texts(renderer.root);
        expect(visible).toContain('Recommended');
        expect(visible).toContain('npm install -g --ignore-scripts @trymuxr/cli@latest && muxr');
        expect(visible).toContain('Paste the pairing string');
        expect(visible).toContain('Connect over SSH');
        // Step 1 (run the command) renders before step 2 (scan the QR it shows).
        expect(visible.indexOf('Step 1 · On your computer, run:')).toBeGreaterThanOrEqual(0);
        expect(visible.indexOf('Step 2 · Scan the QR it shows')).toBeGreaterThan(visible.indexOf('Step 1 · On your computer, run:'));
        // No raw backticks or kit jargon in user-visible copy.
        for (const text of visible) {
            expect(text).not.toContain('`');
            expect(text).not.toContain('byokit-link');
        }
        press(renderer.root, 'Step 2 · Scan the QR it shows. Recommended. Steps: Point this phone at the QR shown by muxr on your computer.');
        await TestRenderer.act(async () => {});
        expect(scanQr).toHaveBeenCalledTimes(1);
        await TestRenderer.act(async () => { scanOnScanned!({ data: 'wss://relay?pair=abc' }); });
        expect(dismissScanner).toHaveBeenCalledTimes(1);
        expect(routerPush).not.toHaveBeenCalled();
        expect(pairingAlert).toHaveBeenCalledWith('Pairing code not usable', expect.stringContaining('muxr 0.2.0 or older'));
        expect(pairingAlert).toHaveBeenCalledTimes(1);
        pairingAlert.mockClear();
        // A cut-off current code names the cut, never the version.
        press(renderer.root, 'Step 2 · Scan the QR it shows. Recommended. Steps: Point this phone at the QR shown by muxr on your computer.');
        await TestRenderer.act(async () => {});
        await TestRenderer.act(async () => { scanOnScanned!({ data: 'byokit-link:1:not-valid!!' }); });
        expect(routerPush).not.toHaveBeenCalled();
        expect(pairingAlert).toHaveBeenCalledWith('Pairing code not usable', expect.stringContaining('cut off'));
        pairingAlert.mockClear();
        // An expired current code opens the pair screen's expired state, which leads with Scan a new code.
        press(renderer.root, 'Step 2 · Scan the QR it shows. Recommended. Steps: Point this phone at the QR shown by muxr on your computer.');
        await TestRenderer.act(async () => {});
        const expired = expiredOffer();
        await TestRenderer.act(async () => { scanOnScanned!({ data: expired }); });
        expect(pairingAlert).not.toHaveBeenCalled();
        expect(routerPush).toHaveBeenCalledWith({ pathname: '/pair', params: { offer: expired } });
        routerPush.mockClear();
        // A wrapped valid offer still pairs: inner whitespace is stripped.
        press(renderer.root, 'Step 2 · Scan the QR it shows. Recommended. Steps: Point this phone at the QR shown by muxr on your computer.');
        await TestRenderer.act(async () => {});
        const whole = freshOffer();
        await TestRenderer.act(async () => { scanOnScanned!({ data: `  ${whole.slice(0, 60)}\n${whole.slice(60)}  ` }); });
        expect(pairingAlert).not.toHaveBeenCalled();
        expect(routerPush).toHaveBeenCalledWith({ pathname: '/pair', params: { offer: whole } });
        pairingAlert.mockClear();
        routerPush.mockClear();
        press(renderer.root, 'Step 2 · Scan the QR it shows. Recommended. Steps: Point this phone at the QR shown by muxr on your computer.');
        await TestRenderer.act(async () => {});
        const offer = freshOffer();
        await TestRenderer.act(async () => { scanOnScanned!({ data: offer }); });
        expect(routerPush).toHaveBeenCalledWith({ pathname: '/pair', params: { offer } });
        expect(pairingAlert).not.toHaveBeenCalled();
        press(renderer.root, 'Paste the pairing string');
        expect(routerPush).toHaveBeenCalledWith('/pair');
        press(renderer.root, 'Connect over SSH');
        expect(routerPush).toHaveBeenCalledWith('/pair?route=ssh');
        TestRenderer.act(() => { renderer.unmount(); });
    });

    it('offers browser pairing as a numbered step with its own paste button, and no scan hint', async () => {
        platformOs = 'web';
        let renderer: any;
        TestRenderer.act(() => { renderer = TestRenderer.create(React.createElement(FirstRunConnection)); });
        const visible = texts(renderer.root);
        // Step 2 is a numbered step (badge 2), like step 1, not inline "Step 2 ·" text.
        const badges = renderer.root.findAllByType('Text')
            .map((node: any) => node.props.children)
            .filter((child: any) => typeof child === 'number');
        expect(badges).toContain(1);
        expect(badges).toContain(2);
        expect(visible).toContain('Paste the browser link');
        expect(visible).toContain('Run one command on your computer, then paste the browser pairing link.');
        expect(visible.some((text) => text.includes('Step 2 ·'))).toBe(false);
        // The camera/scan hint and the duplicate paste route are gone in browser mode.
        expect(visible.some((text) => text.includes("can't point this phone"))).toBe(false);
        expect(visible).not.toContain('Other ways to connect');
        press(renderer.root, 'Paste the browser link');
        await TestRenderer.act(async () => {});
        expect(Modal.prompt).toHaveBeenCalledWith('Paste the pairing string', expect.stringContaining('muxr\u00A0pair\u00A0-\u2060-\u2060browser'), expect.any(Object));
        expect(scanQr).not.toHaveBeenCalled();
        TestRenderer.act(() => { renderer.unmount(); });
    });
});
