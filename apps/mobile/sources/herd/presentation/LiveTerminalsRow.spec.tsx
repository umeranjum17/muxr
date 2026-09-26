import { expect, it, vi } from 'vitest';
import React from 'react';
import TestRenderer from 'react-test-renderer';

vi.mock('react-native', () => ({
    View: 'View',
    Text: 'Text',
    Pressable: 'Pressable',
    FlatList: 'FlatList',
    AppState: { currentState: 'active', addEventListener: () => ({ remove: () => undefined }) },
    useWindowDimensions: () => ({ height: 800, width: 400 }),
    StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
}));
vi.mock('react-native-unistyles', () => ({
    StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
    useUnistyles: () => ({ theme: {
        colors: { text: '#111', textSecondary: '#666', surfaceHigh: '#fff', divider: '#ddd', status: { error: '#c00' } },
    } }),
}));
vi.mock('react-native-reanimated', () => ({
    Animated: { FlatList: 'FlatList' },
    LinearTransition: { duration: () => ({ reduceMotion: () => undefined }) },
    ReduceMotion: { System: 'system' },
}));
vi.mock('@react-navigation/native', () => ({ useIsFocused: () => true }));
vi.mock('@react-native-async-storage/async-storage', () => ({
    default: { getItem: async () => null, setItem: async () => undefined },
}));
vi.mock('react-native-mmkv', () => ({
    MMKV: class { getString() { return undefined; } set() {} delete() {} contains() { return false; } getAllKeys() { return []; } },
}));
vi.mock('expo-localization', () => ({ getLocales: () => [{ languageCode: 'en' }] }));
vi.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));
vi.mock('expo-router', () => ({ useRouter: () => ({ push: () => undefined, dismissTo: () => undefined }) }));
vi.mock('@/catalog/store', () => ({
    storage: { getState: () => ({ herdrWorkspaces: [] }) },
    useHomeHerd: () => ({ sessions: [], workspaces: [], loaded: true, stale: false }),
    useLifecycleEvents: () => [],
    useSocketStatus: () => ({ status: 'connected' }),
}));
vi.mock('@/pairing', () => ({ useDeviceAuthority: () => ({ authority: 'control', loading: false }) }));
vi.mock('../application/renameInHerdr', () => ({ showPaneActions: () => undefined }));
vi.mock('@/components/AgentGlyph', () => ({ AgentGlyph: () => null }));
vi.mock('@/terminal/ui', () => ({ TerminalPreview: () => null }));

// These resolve the mocked modules, so they must stay below the vi.mock calls.
import { LiveTerminalsRow } from './LiveTerminalsRow';

/*
 * The home screen's empty herd was once rendered as corrupted copy and the
 * whole suite stayed green, because no test ever loaded a home component
 * (testing-strategy study, mutant M4). The strip's domain ordering has its own
 * specs; what they cannot see is the words the phone actually draws when
 * nothing is running.
 */
it('says what an empty herd is instead of drawing garbage', async () => {
    let renderer!: ReturnType<typeof TestRenderer.create>;
    await TestRenderer.act(async () => {
        renderer = TestRenderer.create(<LiveTerminalsRow />);
    });
    const lines = (renderer.root as any)
        .findAll((node: { type: unknown; children: unknown[] }) => node.type === 'Text')
        .map((node: { children: unknown[] }) => node.children.filter((child) => typeof child === 'string').join(''));

    expect(lines).toContain('Live');
    expect(lines).toContain('No live agents · start one below');
    expect(lines.join('\n')).not.toMatch(/undefined|NaN|\[object/);
    renderer.unmount();
});
