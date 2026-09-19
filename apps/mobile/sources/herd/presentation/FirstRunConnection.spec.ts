import { describe, expect, it, vi } from 'vitest';
import React from 'react';
import TestRenderer from 'react-test-renderer';

/*
 * Flow tests for the first-connection route chooser: the chooser precedes any
 * QR action, the SSH-fluent route is directly reachable, back returns to the
 * chooser, and the recommended route still feeds the existing QR claim path.
 * The pairing and scanner hooks are mocked at their module seam — the claim
 * journey itself is proven end to end against a real relay elsewhere — so
 * these tests pin exactly the wiring this screen owns.
 */

let platformOs: 'android' | 'web' = 'android';
const routerPush = vi.fn();
const hostedPair = vi.fn(async (_url: string) => undefined);
const scanQr = vi.fn(async () => undefined);
let scanOnScanned: ((url: string) => void) | undefined;

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
vi.mock('@/pairing', () => ({
    useHostedPairing: () => hostedPair,
    usePairQrScanner: (onScanned: (url: string) => void) => {
        scanOnScanned = onScanned;
        return scanQr;
    },
}));
vi.mock('@/connection', () => ({ sshTunnelAvailable: () => platformOs === 'android' }));
vi.mock('@/modal', () => ({ Modal: { prompt: vi.fn(async () => undefined) } }));
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

describe('first-connection route chooser', () => {
    it('shows both routes before any QR action, with the recommended one badged', () => {
        platformOs = 'android';
        let renderer: any;
        TestRenderer.act(() => {
            renderer = TestRenderer.create(React.createElement(FirstRunConnection));
        });
        const visible = texts(renderer.root);
        expect(visible).toContain('Pair with a QR code');
        expect(visible).toContain('Recommended · ~1 min');
        expect(visible).toContain('Connect over SSH');
        expect(visible.some((text) => text.includes('Other ways to connect'))).toBe(true);
        // The scan action only exists after entering the recommended route.
        expect(buttons(renderer.root).some((node) => node.props.accessibilityLabel === 'Scan QR to pair')).toBe(false);
    });

    it('enters the recommended route, then back returns to the chooser', () => {
        platformOs = 'android';
        let renderer: any;
        TestRenderer.act(() => {
            renderer = TestRenderer.create(React.createElement(FirstRunConnection));
        });
        press(renderer.root, 'Pair with a QR code. Recommended · ~1 min');

        // Recommended route: the exact host command, the three What-happens
        // steps, and the QR action. No SSH route content here.
        const recommended = texts(renderer.root);
        expect(recommended).toContain('muxr');
        expect(recommended).toContain('On your computer');
        expect(recommended).toContain('Connect this device');
        expect(recommended).toContain('Review access');
        expect(recommended).not.toContain('SSH host');

        press(renderer.root, 'Back to connection choices');
        expect(texts(renderer.root)).toContain('Connect over SSH');
    });

    it('keeps the QR claim intact: scan action uses the scanner and the scanned link reaches pairing', () => {
        platformOs = 'android';
        let renderer: any;
        TestRenderer.act(() => {
            renderer = TestRenderer.create(React.createElement(FirstRunConnection));
        });
        press(renderer.root, 'Pair with a QR code. Recommended · ~1 min');
        press(renderer.root, 'Scan QR to pair');
        expect(scanQr).toHaveBeenCalledTimes(1);

        // The scanner delivers the short link into the existing hosted pairing
        // flow — unchanged confirm, grant, and login downstream.
        TestRenderer.act(() => {
            scanOnScanned!('wss://relay.example:8792?pair=7KDM4-QXP7N');
        });
        expect(hostedPair).toHaveBeenCalledWith('wss://relay.example:8792?pair=7KDM4-QXP7N');
    });

    it('opens the SSH fields route directly from the chooser', () => {
        platformOs = 'android';
        let renderer: any;
        TestRenderer.act(() => {
            renderer = TestRenderer.create(React.createElement(FirstRunConnection));
        });
        press(renderer.root, 'Connect over SSH');
        expect(routerPush).toHaveBeenCalledWith('/pair?route=ssh');
    });

    it('offers no SSH card where the SSH transport does not exist', () => {
        platformOs = 'web';
        let renderer: any;
        TestRenderer.act(() => {
            renderer = TestRenderer.create(React.createElement(FirstRunConnection));
        });
        const visible = texts(renderer.root);
        expect(visible).toContain('Pair from your computer');
        expect(visible).not.toContain('Connect over SSH');
    });
});
