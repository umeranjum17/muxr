import { beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import TestRenderer from 'react-test-renderer';

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

describe('guided first-connection chooser', () => {
    beforeEach(() => {
        platformOs = 'android';
        routerPush.mockClear();
        hostedPair.mockClear();
        scanQr.mockClear();
    });

    it('opens Scan directly, routes its offer to one consent screen, and keeps manual and SSH entry visible', () => {
        let renderer: any;
        TestRenderer.act(() => { renderer = TestRenderer.create(React.createElement(FirstRunConnection)); });
        const visible = texts(renderer.root);
        expect(visible).toContain('Recommended');
        expect(visible).toContain('npm install -g --ignore-scripts @trymuxr/cli@latest && muxr');
        expect(visible).toContain('Type the pairing code');
        expect(visible).toContain('Connect over SSH');
        press(renderer.root, 'Scan the QR on your computer. Recommended. Steps: Point this phone at the QR shown by muxr on your computer.');
        expect(scanQr).toHaveBeenCalledTimes(1);
        const offer = 'byokit-link:1:offer';
        TestRenderer.act(() => { scanOnScanned!(offer); });
        expect(routerPush).toHaveBeenCalledWith({ pathname: '/pair', params: { offer } });
        expect(hostedPair).not.toHaveBeenCalled();
        press(renderer.root, 'Type the pairing code');
        expect(routerPush).toHaveBeenCalledWith('/pair');
        press(renderer.root, 'Connect over SSH');
        expect(routerPush).toHaveBeenCalledWith('/pair?route=ssh');
        TestRenderer.act(() => { renderer.unmount(); });
    });
});
