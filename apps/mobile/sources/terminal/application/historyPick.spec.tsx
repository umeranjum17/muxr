import { beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import TestRenderer from 'react-test-renderer';

/**
 * The history screen's one risky gesture: tapping a row's plus pops the
 * screen. A double-tap used to fire router.back() twice — the second pop
 * landing on the terminal itself — while the pick stayed queued for later.
 * This drives the real screen through its rendered row button and its real
 * one-shot insertion handoff.
 */

const SESSION = 'session-1';
const PANE = 'pane-1';

const theme = {
    colors: {
        accent: '#0af',
        divider: '#333',
        surface: '#111',
        surfaceHigh: '#222',
        surfaceSelected: '#1a1a2a',
        terminal: { background: '#000' },
        text: '#fff',
        textSecondary: '#999',
    },
};

vi.mock('react-native', () => ({
    ActivityIndicator: 'ActivityIndicator',
    FlatList: (props: { data: unknown[]; renderItem: (info: { item: unknown; index: number }) => React.ReactElement }) =>
        props.data.map((item, index) => props.renderItem({ item, index })),
    Pressable: 'Pressable',
    Text: 'Text',
    TextInput: 'TextInput',
    View: 'View',
}));
vi.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));
vi.mock('react-native-unistyles', () => ({ useUnistyles: () => ({ theme }) }));
vi.mock('@/constants/Typography', () => ({ Typography: { default: () => ({}), mono: () => ({}) } }));
vi.mock('@/catalog/store', () => ({
    useHerdrTree: () => ({ workspaces: [], loaded: true }),
    useSession: () => null,
    useSessionsLoaded: () => true,
    useSocketStatus: () => ({ status: 'connected' }),
}));
vi.mock('@/catalog/sync', () => ({
    sync: { request: () => Promise.resolve({ text: 'line one\nline two', truncated: false }) },
}));
vi.mock('@/herd', () => ({
    agentLabels: () => ({ taskTitle: 'Fix the login bug', agentName: 'Claude' }),
    agentNameLine: () => 'Claude',
    herdrPaneForSession: () => ({ paneId: PANE }),
    isShellLabels: () => false,
}));
vi.mock('@/components/AgentGlyph', () => ({ AgentGlyph: () => null }));
vi.mock('expo-router', async () => {
    const React = await import('react');
    return {
        router: { back: vi.fn() },
        useFocusEffect: (callback: () => void | (() => void)) => {
            React.useEffect(() => callback(), []);
        },
        useLocalSearchParams: () => ({ id: SESSION }),
    };
});

// These resolve the mocked modules, so they must stay below the vi.mock calls.
import { router } from 'expo-router';
import { clearDraftInsertion, consumeDraftInsertion } from '@/terminal/application/draftInsertion';
import HistoryScreen from '@/app/(app)/session/[id]/history';

beforeEach(() => {
    clearDraftInsertion(SESSION);
    vi.clearAllMocks();
});

describe('the history pick gesture', () => {
    it('a double-tapped row pops once and still hands its line over exactly once', async () => {
        let renderer: any;
        await TestRenderer.act(async () => {
            renderer = TestRenderer.create(<HistoryScreen />);
        });
        const row = renderer!.root.findByProps({ accessibilityLabel: 'Insert line 1 into prompt' });
        await TestRenderer.act(async () => {
            row.props.onPress();
            row.props.onPress();
        });
        expect(vi.mocked(router.back)).toHaveBeenCalledTimes(1);
        expect(consumeDraftInsertion(SESSION, PANE)).toBe('line one');
        expect(consumeDraftInsertion(SESSION, PANE)).toBeNull();
    });
});
