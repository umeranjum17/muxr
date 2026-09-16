import { describe, expect, it, vi } from 'vitest';
import React from 'react';
import TestRenderer from 'react-test-renderer';

const theme = vi.hoisted(() => ({
    colors: {
        text: '#000',
        textSecondary: '#555',
        surfaceHigh: '#eee',
        surface: '#fff',
        divider: '#ddd',
        accentSubtle: '#ddf',
        accent: '#00f',
    },
}));

vi.mock('react-native', () => ({
    Platform: { OS: 'web' },
    View: 'View',
    Text: 'Text',
    Pressable: 'Pressable',
}));
vi.mock('react-native-unistyles', () => ({
    StyleSheet: { create: (styles: (theme: unknown) => unknown) => styles(theme) },
    useUnistyles: () => ({ theme }),
}));
vi.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));
vi.mock('expo-clipboard', () => ({ setStringAsync: vi.fn(async () => true) }));
vi.mock('@/catalog', () => ({ loadAppConfig: () => ({}) }));
vi.mock('@/utils/openExternalUrl', () => ({ openExternalUrl: vi.fn() }));

import { FirstRunSetupCard } from './FirstRunSetupCard';

function visibleTexts(root: any): string[] {
    return root.findAllByType('Text').map((node: any) => {
        const children = node.props.children;
        return (Array.isArray(children) ? children : [children]).filter((child) => typeof child === 'string').join('');
    });
}

describe('first-run setup disclosure flow', () => {
    it('shows the setup command with a collapsed What-happens disclosure that expands in place', () => {
        let renderer: any;
        TestRenderer.act(() => {
            renderer = TestRenderer.create(React.createElement(FirstRunSetupCard));
        });
        const root = renderer!.root;
        const toggle = root.findByProps({ accessibilityLabel: 'What running this does' });

        // The copyable command is visible before anything is expanded, and the
        // disclosure starts collapsed so it cannot be mistaken for the command.
        const before = visibleTexts(root);
        expect(before).toContain('muxr');
        expect(before).toContain('What running this does');
        expect(before.some((text) => text.includes('Nothing is installed or changed'))).toBe(false);

        TestRenderer.act(() => {
            toggle.props.onPress();
        });

        // Expanding explains what running the command does, sitting directly
        // under the command row: command, then toggle, then the effects.
        const after = visibleTexts(root);
        const commandAt = after.indexOf('muxr');
        const toggleAt = after.indexOf('What running this does');
        const firstEffectAt = after.findIndex((text) => text.includes('Nothing is installed or changed'));
        expect(commandAt).toBeGreaterThanOrEqual(0);
        expect(toggleAt).toBeGreaterThan(commandAt);
        expect(firstEffectAt).toBeGreaterThan(toggleAt);
        expect(after.some((text) => text.includes('Nothing is installed or changed until you approve the reviewed plan'))).toBe(true);
        expect(after.some((text) => text.includes('lifecycle detection') && text.includes('never agent skills or prompt files'))).toBe(true);
        expect(after.some((text) => text.includes('background services') && text.includes('short-lived QR or string'))).toBe(true);

        TestRenderer.act(() => {
            root.findByProps({ accessibilityLabel: 'What running this does' }).props.onPress();
        });
        expect(visibleTexts(root).some((text) => text.includes('Nothing is installed or changed'))).toBe(false);
    });
});
