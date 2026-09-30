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
    const { useHostedPairing, usePairQrScanner } = await import('@/pairing/application/usePairing');
    return { useHostedPairing, usePairQrScanner };
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
vi.mock('@/pairing/application/useCheckCameraPermissions', () => ({ useCheckScannerPermissions: () => async () => true }));
vi.mock('@/account/ui', () => ({ useAuth: () => ({}) }));
vi.mock('@/pairing/application/linkPairing', () => ({ linkPairMachineName: vi.fn(), pairOverLink: vi.fn() }));
vi.mock('@/pairing/application/PairMachine', () => ({ pairMachine: vi.fn() }));
vi.mock('@/pairing/infrastructure/pairingPlatform', () => ({
    pairingDeviceKind: () => platformOs === 'web' ? 'browser' : 'phone',
}));
vi.mock('@/connection', () => ({ sshTunnelAvailable: () => platformOs === 'android' }));
vi.mock('@/modal', () => ({ Modal: { prompt: vi.fn(async () => undefined), alert: (...args: unknown[]) => pairingAlert(...args) } }));
vi.mock('@/components/haptics', () => ({ hapticsLight: vi.fn() }));
vi.mock('expo-clipboard', () => ({ setStringAsync: vi.fn(async () => true) }));
vi.mock('@/catalog', () => ({ loadAppConfig: () => ({}) }));
vi.mock('@/utils/openExternalUrl', () => ({ openExternalUrl: vi.fn() }));

import { FirstRunConnection } from './FirstRunConnection';

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
        expect(visible).toContain('Type the pairing code');
        expect(visible).toContain('Connect over SSH');
        press(renderer.root, 'Scan the QR on your computer. Recommended. Steps: Point this phone at the QR shown by muxr on your computer.');
        await TestRenderer.act(async () => {});
        expect(scanQr).toHaveBeenCalledTimes(1);
        await TestRenderer.act(async () => { scanOnScanned!({ data: 'wss://relay?pair=abc' }); });
        expect(dismissScanner).toHaveBeenCalledTimes(1);
        expect(routerPush).not.toHaveBeenCalled();
        expect(pairingAlert).toHaveBeenCalledWith('Pairing code expired', expect.stringContaining('Update muxr on both devices, run `muxr pair`'));
        pairingAlert.mockClear();
        press(renderer.root, 'Scan the QR on your computer. Recommended. Steps: Point this phone at the QR shown by muxr on your computer.');
        await TestRenderer.act(async () => {});
        const offer = 'byokit-link:1:offer';
        await TestRenderer.act(async () => { scanOnScanned!({ data: offer }); });
        expect(routerPush).toHaveBeenCalledWith({ pathname: '/pair', params: { offer } });
        expect(pairingAlert).not.toHaveBeenCalled();
        press(renderer.root, 'Type the pairing code');
        expect(routerPush).toHaveBeenCalledWith('/pair');
        press(renderer.root, 'Connect over SSH');
        expect(routerPush).toHaveBeenCalledWith('/pair?route=ssh');
        TestRenderer.act(() => { renderer.unmount(); });
    });
});
