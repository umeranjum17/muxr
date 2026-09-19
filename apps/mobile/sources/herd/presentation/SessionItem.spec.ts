import { beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import TestRenderer from 'react-test-renderer';

/* react-test-renderer ships no TypeScript types; the helpers below rely on
   only the bits this test uses. */
interface TestRendererInstance {
    toJSON(): any;
    root: {
        find(predicate: (node: any) => boolean): any;
        findAll(predicate: (node: any) => boolean): any[];
    };
}

/*
 * Flow test for the home session card: the card is a live terminal preview
 * first, so a working pane reads its visible screen, an offline one does not
 * poll, and the status line stays one dot plus a factual sentence with a
 * quiet elapsed age. The identity/caption lines, the draft badge and the
 * accessibility label all ride along. Component seams are mocked at their
 * module boundary (containers, icons, the preview renderer); the state
 * sentence, caption and composition logic stay real.
 */

const previewProps: any[] = [];
const listProps: any[] = [];
const treeState = vi.hoisted(() => ({ sessions: {} as Record<string, unknown> }));
vi.hoisted(() => { (globalThis as any).__DEV__ = true; });
vi.mock('@/terminal/ui', () => ({
    TerminalPreview: (props: any) => {
        previewProps.push(props);
        return React.createElement('TerminalPreview', props);
    },
}));

vi.mock('react-native', async () => {
    const React = await import('react');
    return {
        View: 'View',
        Text: 'Text',
        Pressable: 'Pressable',
        FlatList: 'FlatList',
        // Minimal section container: rows render through the real renderItem,
        // and the list reports its rows viewable once after mount, as the real
        // one does after layout.
        SectionList: (props: any) => {
            const reported = React.useRef(false);
            React.useEffect(() => {
                if (reported.current) return;
                reported.current = true;
                listProps.push(props);
                props.onViewableItemsChanged?.({
                    viewableItems: props.sections.flatMap((section: any) =>
                        section.data.map((item: any) => ({ item }))),
                });
            });
            return React.createElement('View', {}, props.sections.flatMap((section: any) => [
                props.renderSectionHeader?.({ section }),
                ...section.data.map((item: any) => props.renderItem({ item })),
            ]));
        },
        AppState: { currentState: 'active' },
        Dimensions: { get: () => ({ width: 390, height: 844 }) },
        Platform: {
            get OS() { return 'android'; },
            select: (options: any) => options.default,
        },
    };
});

const theme = vi.hoisted(() => ({
    colors: {
        text: '#000',
        textSecondary: '#555',
        groupped: { background: '#fff', sectionTitle: '#888' },
        surface: '#fff',
        surfaceSelected: '#eef',
        surfaceHigh: '#f4f4f4',
        divider: '#ccc',
        status: { working: '#08f', done: '#0a0', error: '#d00', unread: '#c6a700', disconnected: '#999' },
    },
}));

vi.mock('react-native-unistyles', () => ({
    StyleSheet: { create: (styles: (t: unknown) => unknown) => styles(theme), hairlineWidth: 0.5 },
    useUnistyles: () => ({ theme }),
}));
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ bottom: 0 }) }));
vi.mock('expo-router', () => ({ usePathname: () => '/' }));
vi.mock('@/utils/responsive', () => ({
    useSplitViewLayout: () => false,
    getDeviceType: () => 'phone',
}));
vi.mock('@/utils/requestReview', () => ({ requestReview: () => undefined }));
vi.mock('@/utils/platform', () => ({ isRunningOnMac: () => false }));
vi.mock('../application/useVisibleSessionListViewData', () => ({ useVisibleSessionListViewData: () => [] }));
vi.mock('../application/useNavigateToSession', () => ({ useNavigateToSession: () => vi.fn() }));
vi.mock('./ActiveSessionsGroupCompact', () => ({ ActiveSessionsGroupCompact: () => null }));
vi.mock('./LiveTerminalsRow', () => ({ LiveTerminalsRow: () => null }));
vi.mock('./SessionActionsPopover', () => ({ SessionActionsPopover: () => null }));
vi.mock('@/components/UpdateBanner', () => ({ UpdateBanner: () => null }));
vi.mock('@/components/ShortcutHints', () => ({ SessionShortcutHintBadge: () => null }));
vi.mock('@/components/ProviderIcon', () => ({ ProviderIcon: () => React.createElement('ProviderIcon') }));
vi.mock('@/components/Avatar', () => ({
    Avatar: (props: any) => React.createElement('Avatar', { size: props.size, monochrome: props.monochrome }),
}));
vi.mock('@/components/StatusDot', () => ({
    StatusDot: (props: any) => React.createElement('StatusDot', { color: props.color, isPulsing: props.isPulsing }),
}));
vi.mock('expo-image', () => ({ Image: (props: any) => React.createElement('Image', { source: props.source }) }));
vi.mock('@/components/AgentGlyph', () => ({
    AgentGlyph: (props: any) => React.createElement('AgentGlyph', { name: props.name, size: props.size }),
}));
vi.mock('@/components/StyledText', () => ({
    Text: (props: any) => React.createElement('Text', props, props.children),
}));
vi.mock('@expo/vector-icons', () => ({
    Ionicons: (props: any) => React.createElement('Ionicons', { name: props.name }),
}));
vi.mock('@/text', () => ({
    t: (key: string, params?: Record<string, unknown>) =>
        key + (params ? ' ' + Object.values(params).join(' ') : ''),
}));
vi.mock('@/modal', () => ({ Modal: () => null }));
vi.mock('@/components/ui', () => ({ SectionLabel: () => null }));
vi.mock('@/catalog/store', () => ({
    storage: { getState: () => ({ applyHerdrTree: () => undefined, herdrWorkspaces: [] }) },
    useSession: (id: string) => (treeState.sessions as Record<string, unknown>)[id] ?? null,
}));
vi.mock('@/catalog/sync', () => ({ sync: { request: async () => ({}) } }));
vi.mock('../application/useActivityAcknowledgements', () => ({
    useUnseenDoneSessionIds: () => new Set<string>(),
}));
vi.mock('@/pairing', () => ({
    useDeviceAuthority: () => ({ authority: 'view', loading: false }),
}));

import { SessionItem } from './SessionsList';
import { SpacesTree } from './SpacesTree';
import type { SessionRowData } from '@/catalog/store';
import type { HerdrTreePane, HerdrTreeWorkspace } from '@muxr/contract';

const NOW = Date.now();

function baseSession(over: Partial<SessionRowData>): SessionRowData {
    return {
        id: 's1',
        name: 'Fix auth bug',
        subtitle: '',
        avatarId: 'fox',
        flavor: null,
        clientId: 'herdr',
        identityLine: null,
        providerKind: null,
        modelName: 'gemini',
        activitySummary: null,
        state: 'thinking',
        activeAt: undefined,
        hasDraft: false,
        active: true,
        machineId: 'm1',
        host: 'extreme',
        path: '/home/umer/pockit',
        homeDir: '/home/umer',
        workspaceLabel: null,
        workspaceId: null,
        tabId: null,
        tabLabel: null,
        spawnedBy: null,
        worktreeRepo: null,
        worktreeBranch: null,
        hasUnread: false,
        lifecycleSince: NOW - 4 * 60_000,
        ...over,
    } as SessionRowData;
}

function renderSession(session: SessionRowData, props: { visible?: boolean } = {}) {
    previewProps.length = 0;
    let renderer: unknown;
    TestRenderer.act(() => {
        renderer = TestRenderer.create(React.createElement(SessionItem, { session, ...props }));
    });
    return renderer as TestRendererInstance;
}

function cardLabel(renderer: TestRendererInstance): string {
    const pressable = renderer.root.find(
        (node: any) => node.props?.accessibilityRole === 'button',
    ) as ReactTestInstanceProps;
    return pressable.props.accessibilityLabel as string;
}

function agentRowLabel(renderer: TestRendererInstance): string {
    const pressable = renderer.root.find(
        (node: any) => node.props?.accessibilityRole === 'button' && String(node.props?.accessibilityLabel ?? '').startsWith('Open '),
    ) as ReactTestInstanceProps;
    return pressable.props.accessibilityLabel as string;
}

interface ReactTestInstanceProps {
    props: Record<string, unknown>;
}

function textNodes(renderer: TestRendererInstance): string[] {
    const out: string[] = [];
    const walk = (node: any): void => {
        if (typeof node === 'string') out.push(node);
        if (node?.children) node.children.forEach(walk);
    };
    walk(renderer.toJSON());
    return out;
}

describe('session card flow', () => {
    beforeEach(() => {
        previewProps.length = 0;
    });

    it('a working session reads its pane live, with elapsed age as secondary text', () => {
        const renderer = renderSession(baseSession({}));
        const preview = previewProps[previewProps.length - 1];
        expect(preview.sessionId).toBe('s1');
        expect(preview.live).toBe(true);
        expect(preview.paused).toBe(false);
        expect(cardLabel(renderer)).toBe('Fix auth bug, status.working');
        expect(textNodes(renderer)).toContain('4m');
        // The mono machine/path caption sits under the name.
        expect(textNodes(renderer)).toContain('extreme · pockit');
    });

    it('a scrolled-away row pauses its snapshot without changing what it says', () => {
        const renderer = renderSession(baseSession({}), { visible: false });
        const preview = previewProps[previewProps.length - 1];
        expect(preview.paused).toBe(true);
        expect(cardLabel(renderer)).toBe('Fix auth bug, status.working');
    });

    it('an offline session does not poll and says when it was last seen', () => {
        const renderer = renderSession(baseSession({
            state: 'disconnected',
            active: false,
            activeAt: NOW - 2 * 3_600_000,
            lifecycleSince: undefined,
        }));
        expect(previewProps[previewProps.length - 1].live).toBe(false);
        expect(textNodes(renderer).join(' ')).toContain('status.lastSeen');
        expect(textNodes(renderer).join(' ')).toContain('status.offlineSeen');
        expect(cardLabel(renderer)).toBe('Fix auth bug, status.lastSeen time.hoursAgo 2');
    });

    it('a session waiting for approval names the ask', () => {
        const renderer = renderSession(baseSession({ state: 'permission_required' }));
        expect(cardLabel(renderer)).toBe('Fix auth bug, status.waitingApproval');
        expect(textNodes(renderer)).toContain('status.waitingApproval');
    });

    it('finished results read as done and drop the working poll', () => {
        const renderer = renderSession(baseSession({ state: 'waiting', hasUnread: true }));
        expect(previewProps[previewProps.length - 1].live).toBe(false);
        expect(cardLabel(renderer)).toBe('Fix auth bug, status.doneUnread');
    });

    it('an idle session stays quiet', () => {
        const renderer = renderSession(baseSession({ state: 'waiting', lifecycleSince: NOW - 75 * 60_000 }));
        expect(previewProps[previewProps.length - 1].live).toBe(false);
        expect(cardLabel(renderer)).toBe('Fix auth bug, status.idle');
        expect(textNodes(renderer)).toContain('1h');
    });

    it('the agent identity line wins over the machine caption, and a non-herdr row keeps the avatar only', () => {
        const identity = renderSession(baseSession({ identityLine: 'extreme · pi' }));
        expect(textNodes(identity)).toContain('extreme · pi');
        expect(textNodes(identity)).not.toContain('extreme · pockit');

        previewProps.length = 0;
        const plain = renderSession(baseSession({ clientId: null }));
        expect(previewProps).toHaveLength(0);
        const avatars = plain.root.findAll((node: any) => node.type === 'Avatar') as ReactTestInstanceProps[];
        expect(avatars.some((node) => node.props.size === 40)).toBe(true);
    });

    it('a draft rides the avatar badge without touching the label', () => {
        const renderer = renderSession(baseSession({ hasDraft: true }));
        expect(renderer.root.findAll((node: any) => node.type === 'Ionicons').length).toBeGreaterThan(0);
        expect(cardLabel(renderer)).toBe('Fix auth bug, status.working');
    });
});

describe('spaces tree row flow', () => {
    const treePane = {
        paneId: 'w1:p1',
        workspaceId: 'w1',
        tabId: 'w1:t1',
        sessionId: 's1',
        agentStatus: 'working',
        changedAt: NOW - 4 * 60_000,
        cwd: '/home/umer/pockit',
        promptable: true,
        agentKind: 'pi',
        agentName: 'fox',
        taskTitle: 'Fix auth bug',
    } as unknown as HerdrTreePane;

    function renderTree(pane: HerdrTreePane, session?: Record<string, unknown>) {
        const workspace = {
            workspaceId: 'w1',
            label: 'pockit',
            order: 1,
            agentStatus: pane.agentStatus,
            tabs: [{ tabId: 'w1:t1', label: '1', panes: [pane] }],
        } as unknown as HerdrTreeWorkspace;
        previewProps.length = 0;
        listProps.length = 0;
        if (session === undefined) delete treeState.sessions.s1;
        else treeState.sessions.s1 = { id: 's1', ...session };
        let renderer: unknown;
        TestRenderer.act(() => {
            renderer = TestRenderer.create(React.createElement(SpacesTree, {
                workspaces: [workspace],
                refresh: async () => undefined,
                defaultExpandedWorkspaceIds: ['w1'],
            }));
        });
        return renderer as TestRendererInstance;
    }

    it('a working agent row reads its pane live and captions path and state in mono', () => {
        const renderer = renderTree(treePane);
        const preview = previewProps[previewProps.length - 1];
        expect(preview.sessionId).toBe('s1');
        expect(preview.live).toBe(true);
        expect(preview.paused).toBeFalsy();
        const texts = textNodes(renderer);
        expect(texts).toContain('pockit');
        expect(texts.join(' ')).toContain('Working');
        // The identity line stays spoken even though the caption now carries
        // path and state.
        const rowLabel = agentRowLabel(renderer);
        expect(rowLabel).toContain('Open Fix auth bug');
        expect(rowLabel).toContain('pi/fox');
    });

    it('a finished agent row stops polling and speaks its result with elapsed age', () => {
        const done = renderTree(
            { ...treePane, agentStatus: 'done' },
            { metadata: { lifecycleStateSince: NOW - 75 * 60_000 } },
        );
        expect(previewProps[previewProps.length - 1].live).toBe(false);
        const texts = textNodes(done);
        expect(texts.join(' ')).toContain('Done');
        expect(texts.join(' ')).toContain('1h');
    });

    it('a shell row snapshots once and reads Idle instead of the agent offline word', () => {
        const shell = {
            ...treePane,
            agentStatus: 'unknown',
            agentKind: undefined,
            agentName: undefined,
            taskTitle: 'umer@extreme:~/pockit',
        } as unknown as HerdrTreePane;
        const renderer = renderTree(shell);
        const preview = previewProps[previewProps.length - 1];
        expect(preview.sessionId).toBe('s1');
        expect(preview.live).toBe(false);
        expect(textNodes(renderer)).toContain('status.idle');
        expect(textNodes(renderer)).not.toContain('Offline');
    });

    it('a scrolled-away card pauses its previews without changing what it says', () => {
        const renderer = renderTree(treePane);
        expect(previewProps[previewProps.length - 1].paused).toBe(false);
        TestRenderer.act(() => {
            listProps[0].onViewableItemsChanged({ viewableItems: [] });
        });
        expect(previewProps[previewProps.length - 1].paused).toBe(true);
        expect(agentRowLabel(renderer)).toContain('Open Fix auth bug');
    });
});
