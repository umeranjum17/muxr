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
    machineId: 'lab-machine',
    frame: '',
    readRoutes: [] as string[],
    appStateListeners: [] as ((state: string) => void)[],
}));

vi.mock('react-native', () => ({
    View: 'View',
    Text: 'Text',
    Pressable: 'Pressable',
    FlatList: 'FlatList',
    AppState: { currentState: 'active', addEventListener: (_event: string, listener: (state: string) => void) => {
        herd.appStateListeners.push(listener);
        return { remove: () => { herd.appStateListeners = herd.appStateListeners.filter((held) => held !== listener); } };
    } },
    useWindowDimensions: () => ({ height: 800, width: 400 }),
    StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
}));
vi.mock('react-native-unistyles', () => ({
    StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
    useUnistyles: () => ({ theme: {
        colors: { text: '#111', textSecondary: '#666', surfaceHigh: '#fff', divider: '#ddd', status: { error: '#c00' }, groupped: { chevron: '#999' } },
    } }),
}));
vi.mock('react-native-reanimated', async () => {
    const { createElement, Fragment } = await import('react');
    return {
        default: { FlatList: (props: any) => createElement('FlatList', props,
            props.data.map((item: unknown, index: number) => createElement(Fragment,
                { key: props.keyExtractor(item) }, props.renderItem({ item, index })))) },
        LinearTransition: { duration: () => ({ reduceMotion: () => undefined }) },
        ReduceMotion: { System: 'system' },
    };
});
vi.mock('@react-navigation/native', () => ({ useIsFocused: () => true }));
vi.mock('@react-native-async-storage/async-storage', () => ({
    default: { getItem: async () => JSON.stringify(herd.seen), setItem: async () => undefined },
}));
vi.mock('react-native-mmkv', () => ({
    createMMKV: () => new class { getString() { return undefined; } set() {} remove() {} contains() { return false; } getAllKeys() { return []; } }(),
}));
vi.mock('expo-localization', () => ({ getLocales: () => [{ languageCode: 'en' }] }));
vi.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));
vi.mock('expo-router', () => ({ useRouter: () => ({ push: () => undefined, dismissTo: () => undefined }) }));
vi.mock('@/catalog/store', () => ({
    storage: Object.assign((selector: (state: { activeMachineId: string; herdrWorkspaces: HerdrTreeWorkspace[] }) => unknown) =>
        selector({ activeMachineId: herd.machineId, herdrWorkspaces: [] }), { getState: () => ({ herdrWorkspaces: [] }) }),
    useHomeHerd: () => ({ sessions: [], workspaces: herd.workspaces, loaded: true, stale: false }),
    useHomeNeedsYouIds: () => needsYouSessionIds(herd.workspaces, []),
    useLifecycleEvents: () => herd.events,
    useSocketStatus: () => ({ status: 'connected' }),
}));
vi.mock('@/pairing', () => ({ useDeviceAuthority: () => ({ authority: 'control', loading: false }) }));
vi.mock('../application/renameInHerdr', () => ({ showPaneActions: () => undefined }));
vi.mock('@/components/AgentGlyph', () => ({ AgentGlyph: () => null }));
vi.mock('@/terminal/ui', () => import('../../terminal/presentation/TerminalPreview'));
vi.mock('@/catalog/sync', () => ({ sync: { request: async (_method: string, input: { sessionId: string }) => {
    herd.readRoutes.push(input.sessionId);
    return { text: herd.frame };
} } }));

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
    // Home holds a brief flip before moving a row; the authoritative count
    // can update immediately, but no second Home row is introduced meanwhile.
    expect(needsYouRows(renderer)).toHaveLength(2);
    await TestRenderer.act(async () => { await new Promise((resolve) => setTimeout(resolve, 1_600)); });
    expect(needsYouRows(renderer)).toEqual(['Write the release notes']);
    expect(needsYouRows(renderer)).toHaveLength(needsYouSessionIds(herd.workspaces, []).size);
    expect(rowLabels(renderer, /Could not start/)).toEqual(['Deploy the preview']);
    renderer.unmount();
});

/*
 * A Codex and a pi agent that have finished but have not published a real
 * name yet arrive as lifecycle events whose agentName is Herdr's internal
 * launch id (`pp_<hex>` / `pph_<hex>`). Their Ready · unseen rows once led
 * with that id (seen on Android where HOME names an agent); they must name the agent the
 * way Home names every other one — its kind and task, never the id.
 */
it('names a finished Codex and pi agent by kind, never a launch id', async () => {
    const at = new Date().toISOString();
    herd.workspaces = [];
    herd.events = [
        { eventId: 'codex-done', sessionId: 'codex-gone', agentName: 'pp_9c526c448bbeb98f', agentKind: 'codex', state: 'done', reasonCode: 'agent-done', at } as LifecycleEvent,
        { eventId: 'pi-done', sessionId: 'pi-gone', agentName: 'pph_6ba0c0cdd02bca79', agentKind: 'pi', state: 'done', reasonCode: 'agent-done', at } as LifecycleEvent,
    ];
    let renderer!: ReturnType<typeof TestRenderer.create>;
    await TestRenderer.act(async () => {
        renderer = TestRenderer.create(<LiveTerminalsRow showZeroState={false} />);
    });
    // No panes are in the tree, so the only rows are the Ready · unseen tier.
    const titles = (renderer.root as any)
        .findAll((node: { type: unknown; props: { accessibilityLabel?: string } }) =>
            node.type === 'Pressable' && typeof node.props.accessibilityLabel === 'string')
        .map((node: { props: { accessibilityLabel: string } }) => node.props.accessibilityLabel.split('.')[0]);
    expect(titles.sort()).toEqual(['Codex', 'Pi']);
    expect(titles.join(' ')).not.toMatch(/pph?_/i);
    renderer.unmount();
});


it('carries the last frame through Needs you and a replacement route, but not another computer', async () => {
    const tree = (sessionId: string, status: 'working' | 'blocked'): HerdrTreeWorkspace[] => [{
        workspaceId: 'preview-workspace', focused: false, tabs: [{ tabId: 'preview-tab', focused: false, panes: [{
            paneId: `pane-${sessionId}`, tabId: 'preview-tab', focused: false, sessionId,
            agentName: 'preview-agent', agentKind: 'pi', label: 'Review the update', agentStatus: status, promptable: true,
        }] }],
    } as HerdrTreeWorkspace];
    herd.events = [];
    herd.machineId = 'preview-computer';
    herd.frame = 'previous visible terminal frame';
    herd.workspaces = tree('preview-old-route', 'working');
    let renderer!: ReturnType<typeof TestRenderer.create>;
    const text = () => (renderer.root as any).findAll((node: { type: unknown }) => node.type === 'Text')
        .flatMap((node: { children: unknown[] }) => node.children.filter((child) => typeof child === 'string')).join('\n');
    await TestRenderer.act(async () => { renderer = TestRenderer.create(<LiveTerminalsRow />); });
    expect(text()).toContain(herd.frame);

    herd.workspaces = tree('preview-old-route', 'blocked');
    await TestRenderer.act(async () => { renderer.update(<LiveTerminalsRow showZeroState={false} />); });
    await TestRenderer.act(async () => { await new Promise((resolve) => setTimeout(resolve, 1_600)); });
    expect(text()).toContain('Needs you');
    expect(text()).not.toContain(herd.frame); // The real Live preview has unmounted.

    herd.frame = '';
    herd.workspaces = tree('preview-new-route', 'working');
    await TestRenderer.act(async () => { renderer.update(<LiveTerminalsRow showZeroState />); });
    await TestRenderer.act(async () => { await new Promise((resolve) => setTimeout(resolve, 1_600)); });
    expect(herd.readRoutes.at(-1)).toBe('preview-new-route'); // Reads still target the authorized current route.
    expect(text()).toContain('previous visible terminal frame');
    expect(text()).not.toContain('Nothing to show yet');

    herd.frame = 'replacement terminal output';
    await TestRenderer.act(async () => {
        for (const listener of herd.appStateListeners) listener('background');
        for (const listener of herd.appStateListeners) listener('active');
    });
    expect(text()).toContain(herd.frame);
    herd.frame = '';
    herd.machineId = 'another-preview-computer';
    await TestRenderer.act(async () => { renderer.update(<LiveTerminalsRow showZeroState={false} />); });
    expect(text()).not.toContain('replacement terminal output');
    await TestRenderer.act(async () => { renderer.unmount(); });
});
