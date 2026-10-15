import { describe, expect, it, vi } from 'vitest';
import React from 'react';
import TestRenderer from 'react-test-renderer';

/*
 * Flow test for the narrow-width SSH fingerprint hold: at a 270 dp window
 * the in-app dialog (which replaced the unstyleable platform alert on
 * Android) shows the whole review and both answers, and only an explicit
 * "Fingerprint matches" approves — Cancel and any other dismissal decline,
 * so silence can never pin a key. Real SshFingerprintDialog component; only
 * the platform seams (dimensions, theme, modal host) are doubled.
 */

let platformOs: 'android' | 'web' = 'android';

vi.mock('react-native', () => ({
    Platform: { get OS() { return platformOs; } },
    // 270 dp reference viewport (1080x2376 at density 640), font at largest.
    useWindowDimensions: () => ({ width: 270, height: 594, scale: 4, fontScale: 2.0 }),
    View: 'View',
    Text: 'Text',
    Pressable: 'Pressable',
    ScrollView: 'ScrollView',
}));
vi.mock('react-native-unistyles', () => ({
    StyleSheet: {
        create: (styles: Record<string, unknown>) => styles,
        hairlineWidth: 1,
    },
    useUnistyles: () => ({
        theme: {
            colors: {
                text: '#000',
                textLink: '#00f',
                surface: '#fff',
                divider: '#ccc',
                glass: { border: '#eee' },
                shadow: { color: '#000' },
            },
        },
    }),
}));
vi.mock('@/constants/Typography', () => ({
    Typography: { default: () => ({}), mono: () => ({}) },
}));

const modal = vi.hoisted(() => ({
    show: vi.fn((_config: unknown) => 'modal-id'),
    hide: vi.fn(),
    confirm: vi.fn(async () => false),
}));
vi.mock('@/modal', () => ({ Modal: modal }));

import { SshFingerprintDialog, confirmSshFingerprint } from './SshFingerprintDialog';

const FINGERPRINT = 'SHA256:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

function renderedTexts(root: TestRenderer.ReactTestInstance): string[] {
    return root.findAllByType('Text').map((node) => node.props.children)
        .filter((child): child is string => typeof child === 'string');
}

describe('SshFingerprintDialog at 270 dp', () => {
    it('reads whole with both answers stacked, and only an explicit match approves', async () => {
        let confirmed = false;
        let cancelled = false;
        let renderer: TestRenderer.ReactTestRenderer | undefined;
        TestRenderer.act(() => {
            renderer = TestRenderer.create(
                <SshFingerprintDialog
                    fingerprint={FINGERPRINT}
                    onConfirm={() => { confirmed = true; }}
                    onCancel={() => { cancelled = true; }}
                />,
            );
        });
        const root = renderer!.root;

        // The full review copy is on screen, fingerprint whole on its own line.
        const texts = renderedTexts(root);
        expect(texts).toContain('Check SSH fingerprint');
        expect(texts).toContain('Compare this fingerprint with your provider console before continuing.');
        expect(texts).toContain(FINGERPRINT);
        expect(texts).toContain('No login details have been sent.');

        // The fingerprint must not grab focus and scroll the title away.
        const fingerprintNode = root.findAllByType('Text')
            .find((node) => node.props.children === FINGERPRINT);
        expect(fingerprintNode?.props.selectable).not.toBe(true);

        // Both answers are stacked full-width, Cancel first like the alert
        // order, so the long confirm label cannot squeeze its neighbour.
        const buttons = root.findAllByType('Pressable');
        expect(buttons.map((button) => button.props.accessibilityLabel)).toEqual([
            'Cancel',
            'Fingerprint matches',
        ]);

        // A fixed 340-wide card would fill the 270 dp viewport edge to edge;
        // the dialog shrinks with the window instead.
        const container = root.findAllByType('View')[0];
        expect(container.props.style.width).toBeLessThan(270);

        // Tapping the visible answers routes to the right outcome.
        buttons[0].props.onPress();
        expect(cancelled).toBe(true);
        expect(confirmed).toBe(false);
        buttons[1].props.onPress();
        expect(confirmed).toBe(true);
    });

    it('resolves true only for Fingerprint matches; Cancel and dismiss decline', async () => {
        platformOs = 'android';
        try {
            const pending = confirmSshFingerprint(FINGERPRINT);
            expect(modal.show).toHaveBeenCalledOnce();
            const config = modal.show.mock.calls[0][0] as {
                component: typeof SshFingerprintDialog;
                closeOnBackdrop: boolean;
                props: {
                    fingerprint: string;
                    onConfirm: () => void;
                    onCancel: () => void;
                    onDismiss: () => void;
                };
            };
            // The dialog opens the exact probed fingerprint, and a stray
            // backdrop tap is not an answer.
            expect(config.component).toBe(SshFingerprintDialog);
            expect(config.props.fingerprint).toBe(FINGERPRINT);
            expect(config.closeOnBackdrop).toBe(false);

            config.props.onDismiss();
            await expect(pending).resolves.toBe(false);

            const cancelPending = confirmSshFingerprint(FINGERPRINT);
            const cancelConfig = modal.show.mock.calls[1][0] as typeof config;
            cancelConfig.props.onCancel();
            await expect(cancelPending).resolves.toBe(false);

            const confirmPending = confirmSshFingerprint(FINGERPRINT);
            const confirmConfig = modal.show.mock.calls[2][0] as typeof config;
            confirmConfig.props.onConfirm();
            await expect(confirmPending).resolves.toBe(true);
        } finally {
            platformOs = 'android';
        }
    });
});
