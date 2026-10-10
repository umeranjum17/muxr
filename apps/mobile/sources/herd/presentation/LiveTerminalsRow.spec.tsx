import { expect, it, vi } from 'vitest';
import React from 'react';
import TestRenderer from 'react-test-renderer';
import type { HerdrTreeWorkspace, LifecycleEvent } from '@trymuxr/contract';

// What the phone holds: the Herdr tree, its lifecycle events, and the seen marks
// persisted from earlier visits (read once, on the first mount in this file).
const herd = vi.hoisted(() => ({
    workspaces: [] as HerdrTreeWorkspace[],
    events: [] as LifecycleEvent[],
    seen: ['pi-blocked'],
}));

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
        colors: { text: '#111', textSecondary: '#666', surfaceHigh: '#fff', divider: '#ddd', status: { error: '#c00' }, groupped: { chevron: '#999' } },
    } }),
}));
vi.mock('react-native-reanimated', () => ({
    default: { FlatList: 'FlatList' },
    LinearTransition: { duration: () => ({ reduceMotion: () => undefined }) },
    ReduceMotion: { System: 'system' },
}));
vi.mock('@react-navigation/native', () => ({ useIsFocused: () => true }));
vi.mock('@react-native-async-storage/async-storage', () => ({
    default: { getItem: async () => JSON.stringify(herd.seen), setItem: async () => undefined },
}));
vi.mock('react-native-mmkv', () => ({
    MMKV: class { getString() { return undefined; } set() {} delete() {} contains() { return false; } getAllKeys() { return []; } },
}));
vi.mock('expo-localization', () => ({ getLocales: () => [{ languageCode: 'en' }] }));
vi.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));
vi.mock('expo-router', () => ({ useRouter: () => ({ push: () => undefined, dismissTo: () => undefined }) }));
vi.mock('@/catalog/store', () => ({
    storage: { getState: () => ({ herdrWorkspaces: [] }) },
    useHomeHerd: () => ({ sessions: [], workspaces: herd.workspaces, loaded: true, stale: false }),
    useHomeNeedsYouIds: () => needsYouSessionIds(herd.workspaces, []),
    useLifecycleEvents: () => herd.events,
    useSocketStatus: () => ({ status: 'connected' }),
}));
vi.mock('@/pairing', () => ({ useDeviceAuthority: () => ({ authority: 'control', loading: false }) }));
vi.mock('../application/renameInHerdr', () => ({ showPaneActions: () => undefined }));
vi.mock('@/components/AgentGlyph', () => ({ AgentGlyph: () => null }));
vi.mock('@/terminal/ui', () => ({ TerminalPreview: () => null }));

// These resolve the mocked modules, so they must stay below the vi.mock calls.
import { LiveTerminalsRow } from './LiveTerminalsRow';
import { needsYouSessionIds } from '../domain/herdTree';

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

/*
 * Two agents blocked; the first one's Live card had been on screen, so its
 * needs-you event is marked seen. The list once dropped it while its card, the
 * Spaces count and the badge still said it needed you: a count of 2 over a
 * list of 1. The list now lists exactly the agents the count counts, and an
 * agent leaves both together only when it is answered.
 */
it('lists every agent the needs-you count counts until it is answered', async () => {
    const at = new Date().toISOString();
    const agent = (sessionId: string, agentName: string, label: string, agentStatus: 'blocked' | 'working') => ({
        paneId: `pane-${sessionId}`, tabId: 'tab', focused: false, sessionId, agentName, agentKind: 'pi', label, agentStatus, promptable: true,
    });
    const tree = (piStatus: 'blocked' | 'working'): HerdrTreeWorkspace[] => [{
        workspaceId: 'ws', focused: false, agentStatus: 'blocked',
        tabs: [{ tabId: 'tab', focused: false, agentStatus: 'blocked', panes: [
            agent('pi', 'pi-1', 'Fix the login redirect', piStatus),
            agent('claude', 'claude-1', 'Write the release notes', 'blocked'),
        ] }],
    } as HerdrTreeWorkspace];
    herd.events = [
        { eventId: 'claude-blocked', sessionId: 'claude', agentName: 'claude-1', state: 'blocked', reasonCode: 'agent-blocked', at } as LifecycleEvent,
        { eventId: 'pi-blocked', sessionId: 'pi', agentName: 'pi-1', state: 'blocked', reasonCode: 'agent-blocked', at } as LifecycleEvent,
        // An agent that could not start: it has left the tree, so it is no Needs you row.
        { eventId: 'gone-failed', sessionId: 'gone', agentName: 'pi-2', taskTitle: 'Deploy the preview', state: 'failed', reasonCode: 'start-launch-failed', at } as LifecycleEvent,
    ];
    herd.workspaces = tree('blocked');
    const rowLabels = (renderer: ReturnType<typeof TestRenderer.create>, tier: RegExp) => (renderer.root as any)
        .findAll((node: { type: unknown; props: { accessibilityLabel?: string } }) =>
            node.type === 'Pressable' && tier.test(node.props.accessibilityLabel ?? ''))
        .map((node: { props: { accessibilityLabel: string } }) => node.props.accessibilityLabel.split('.')[0]);
    const needsYouRows = (renderer: ReturnType<typeof TestRenderer.create>) => rowLabels(renderer, /Needs you/);

    let renderer!: ReturnType<typeof TestRenderer.create>;
    await TestRenderer.act(async () => {
        renderer = TestRenderer.create(<LiveTerminalsRow />);
    });
    expect(needsYouRows(renderer).sort()).toEqual(['Fix the login redirect', 'Write the release notes']);
    expect(needsYouRows(renderer)).toHaveLength(needsYouSessionIds(herd.workspaces, []).size);
    expect(rowLabels(renderer, /Could not start/)).toEqual(['Deploy the preview']);

    herd.workspaces = tree('working');
    await TestRenderer.act(async () => {
        renderer.update(<LiveTerminalsRow showZeroState={false} />);
    });
    expect(needsYouRows(renderer)).toEqual(['Write the release notes']);
    expect(needsYouRows(renderer)).toHaveLength(needsYouSessionIds(herd.workspaces, []).size);
    expect(rowLabels(renderer, /Could not start/)).toEqual(['Deploy the preview']);
    renderer.unmount();
});
