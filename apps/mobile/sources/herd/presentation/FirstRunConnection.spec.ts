import { beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import TestRenderer from 'react-test-renderer';

/*
 * Flow tests for the guided first-connection chooser: the chooser precedes any
 * QR action and previews both route shapes, the recommended route walks
 * Run → Scan one step at a time with back returning to the chooser, the QR
 * claim wiring stays intact, and the SSH-fluent route is directly reachable.
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

import { Modal } from '@/modal';
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

    it('shows both route shapes before any QR action, each previewing its steps', () => {
        platformOs = 'android';
        let renderer: any;
        TestRenderer.act(() => {
            renderer = TestRenderer.create(React.createElement(FirstRunConnection));
        });
        const visible = texts(renderer.root);
        expect(visible).toContain('Pair with a QR code');
        expect(visible).toContain('Recommended · ~1 min');
        expect(visible).toContain('Connect over SSH');
        // The previews teach the shape of each path before committing.
        expect(visible.some((text) => text.includes('Run one command') && text.includes('Scan the QR'))).toBe(true);
        expect(visible.some((text) => text.includes('Host') && text.includes('no QR'))).toBe(true);
        expect(visible.some((text) => text.includes('Other ways to connect'))).toBe(true);
        // No scan action and no SSH form before a route is chosen.
        expect(buttons(renderer.root).some((node) => node.props.accessibilityLabel === 'I ran it — scan the QR')).toBe(false);
        expect(texts(renderer.root)).not.toContain('SSH host');
    });

    it('walks Run → Scan with the QR in its own state, and back returns toward the chooser', () => {
        let renderer: any;
        TestRenderer.act(() => {
            renderer = TestRenderer.create(React.createElement(FirstRunConnection));
        });
        press(renderer.root, 'Pair with a QR code. Recommended · ~1 min. Steps: 1 Run one command  →  2 Scan the QR  →  3 Done');

        // Run step: the exact host command under the progress rail, no scan yet.
        const run = texts(renderer.root);
        expect(run).toContain('muxr');
        expect(run).toContain('Step 1 · On your computer');
        expect(run).toContain('Run');
        expect(run).toContain('Scan');
        expect(run).toContain('Review');

        // Advance to the scan step: the bounded viewfinder is the resting
        // state; the camera opens only from its explicit action.
        TestRenderer.act(() => {
            press(renderer.root, 'I ran it — scan the QR');
        });
        expect(scanQr).not.toHaveBeenCalled();
        const scan = texts(renderer.root);
        expect(scan.some((text) => text.includes('Point this phone at the QR'))).toBe(true);
        press(renderer.root, 'Open the scanner');
        expect(scanQr).toHaveBeenCalledTimes(1);
        press(renderer.root, 'Paste a pairing string instead');
        expect(Modal.prompt).toHaveBeenCalledWith('Enter pairing string', expect.stringContaining('`muxr pair`'), expect.anything());
        expect(Modal.prompt).not.toHaveBeenCalledWith('Enter pairing string', expect.stringContaining('`muxr pair --browser`'), expect.anything());

        // "Different route" from the scan step returns toward the run step.
        press(renderer.root, '← Different route');
        expect(texts(renderer.root)).toContain('Step 1 · On your computer');

        // And from the run step, back lands on the chooser again.
        press(renderer.root, '← Different route');
        expect(texts(renderer.root)).toContain('Connect over SSH');
    });

    it('keeps the QR claim intact: the scanner hands the scanned link to hosted pairing', () => {
        let renderer: any;
        TestRenderer.act(() => {
            renderer = TestRenderer.create(React.createElement(FirstRunConnection));
        });
        press(renderer.root, 'Pair with a QR code. Recommended · ~1 min. Steps: 1 Run one command  →  2 Scan the QR  →  3 Done');
        press(renderer.root, 'I ran it — scan the QR');
        press(renderer.root, 'Open the scanner');
        expect(scanQr).toHaveBeenCalledTimes(1);

        // The scanner delivers the short link into the existing hosted pairing
        // flow — unchanged confirm, grant, and login downstream.
        TestRenderer.act(() => {
            scanOnScanned!('wss://relay.example:8792?pair=7KDM4-QXP7N');
        });
        expect(hostedPair).toHaveBeenCalledWith('wss://relay.example:8792?pair=7KDM4-QXP7N');
    });

    it('opens the SSH fields route directly from the chooser', () => {
        let renderer: any;
        TestRenderer.act(() => {
            renderer = TestRenderer.create(React.createElement(FirstRunConnection));
        });
        press(renderer.root, 'Connect over SSH. Steps: 1 Host  →  2 User  →  3 Key — no QR.');
        expect(routerPush).toHaveBeenCalledWith('/pair?route=ssh');
    });

    it('offers no SSH tile where the SSH transport does not exist', () => {
        platformOs = 'web';
        let renderer: any;
        TestRenderer.act(() => {
            renderer = TestRenderer.create(React.createElement(FirstRunConnection));
        });
        const visible = texts(renderer.root);
        expect(visible).toContain('Pair with a QR code');
        expect(visible).not.toContain('Connect over SSH');
    });
});
