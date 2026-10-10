import { expect, it, vi } from 'vitest';
import React from 'react';
import TestRenderer from 'react-test-renderer';

vi.mock('react-native', () => ({
    View: 'View',
    Text: 'Text',
    Pressable: 'Pressable',
    ScrollView: 'ScrollView',
    Platform: { OS: 'ios', select: (options: Record<string, unknown>) => options.ios },
    StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
}));
vi.mock('react-native-unistyles', () => ({
    useUnistyles: () => ({ theme: {
        colors: {
            text: '#111', textSecondary: '#666', textLink: '#06c',
            surfaceHigh: '#fff', surfacePressed: '#eee', surfaceSelected: '#ddd',
            divider: '#ddd', accent: '#06c',
            status: { working: '#0a0', error: '#c00', done: '#090', disconnected: '#999' },
        },
    } }),
    ScopedTheme: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
}));
vi.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));
vi.mock('expo-localization', () => ({ getLocales: () => [{ languageCode: 'en' }] }));
vi.mock('@/components/AgentGlyph', () => ({ AgentGlyph: () => null }));
vi.mock('@/components/StatusDot', () => ({ StatusDot: () => null }));
vi.mock('@/components/OptionSheet', () => ({
    OptionSheet: ({ body }: { body?: React.ReactNode }) => <>{body}</>,
}));
vi.mock('@/modal', () => ({ Modal: { alert: vi.fn() } }));
vi.mock('./AgentPickerSheet', () => ({ AgentPickerSheet: () => null }));
vi.mock('../application/renameInHerdr', () => ({ showPaneActions: () => undefined, showTabActions: () => undefined }));
const request = vi.hoisted(() => vi.fn());
const refreshHerdTree = vi.hoisted(() => vi.fn());
vi.mock('@/catalog/sync', () => ({ sync: { request, refreshHerdTree } }));
vi.mock('@/catalog', () => ({}));
vi.mock('@/catalog/application/persistence', () => ({ loadSettings: () => ({ settings: {}, version: null }) }));
vi.mock('@/pairing', () => ({ useDeviceAuthority: () => ({ authority: 'control', loading: false }) }));
vi.mock('@/connection', () => ({ getCachedConnectionSettings: () => ({ machineId: 'm' }) }));
const navigate = vi.hoisted(() => vi.fn());
vi.mock('../application/useNavigateToSession', () => ({
    rememberPaneSelection: () => undefined,
    useNavigateToSession: () => navigate,
}));

// These resolve the mocked modules, so they must stay below the vi.mock calls.
import { PaneOverviewSheet } from './PaneOverviewSheet';
import type { HerdrTreePane, HerdrTreeWorkspace } from '@trymuxr/contract';

function pane(paneId: string, title: string): HerdrTreePane {
    return {
        paneId, tabId: 't', agentName: title, taskTitle: `${title} task`,
        agentStatus: 'idle', promptable: true, focused: paneId === 'a', sessionId: `s-${paneId}`,
    };
}

const workspaces: HerdrTreeWorkspace[] = [{
    workspaceId: 'w', focused: true, agentStatus: 'idle',
    tabs: [{ tabId: 't', focused: true, agentStatus: 'idle', panes: [pane('a', 'left'), pane('b', 'right')] }],
}];

vi.mock('@/catalog/store', () => ({
    useHerdrTree: () => ({ workspaces, loaded: true }),
    useLiveAgentIds: () => ({ needsYouIds: new Set<string>(), pendingIds: new Set<string>() }),
}));

async function renderSheet() {
    request.mockImplementation(async (type: string) => type === 'herdr.layout'
        ? { layout: {
            area: { x: 0, y: 0, width: 120, height: 40 },
            panes: [
                { paneId: 'a', rect: { x: 0, y: 0, width: 60, height: 40 } },
                { paneId: 'b', rect: { x: 60, y: 0, width: 60, height: 40 } },
            ],
        } }
        : {});
    refreshHerdTree.mockResolvedValue({});
    const closed: number[] = [];
    const spaces: number[] = [];
    navigate.mockClear();
    let renderer!: ReturnType<typeof TestRenderer.create>;
    await TestRenderer.act(async () => {
        renderer = TestRenderer.create(
            <PaneOverviewSheet
                visible
                sessionId="s-a"
                onClose={() => { closed.push(1); }}
                onOpenSpaces={() => { spaces.push(1); }}
            />,
        );
        await Promise.resolve();
    });
    // The map measures its own width before it draws any tile.
    const measurer = (renderer.root as any).find((node: { type: unknown; props?: any }) => typeof node.props?.onLayout === 'function');
    await TestRenderer.act(async () => {
        measurer.props.onLayout({ nativeEvent: { layout: { width: 300 } } });
        await Promise.resolve();
    });
    return { renderer, closed, spaces };
}

/*
 * The sheet is the intent's selector: it draws the tab's real split, tapping
 * another pane's tile navigates to that session and closes the sheet, and
 * Spaces hands over to the whole workspace tree.
 */
it('selects the tapped pane and hands Spaces over to the workspace tree', async () => {
    const { renderer, closed, spaces } = await renderSheet();
    const tiles = (renderer.root as any).findAll(
        (node: { type: unknown; props?: any }) => node.type === 'Pressable'
            && typeof node.props?.accessibilityLabel === 'string'
            && /^(Current|Open) pane/.test(node.props.accessibilityLabel),
    );
    expect(tiles).toHaveLength(2);
    const other = tiles.find((tile: { props: any }) => /^Open pane, right/.test(tile.props.accessibilityLabel))!;
    await TestRenderer.act(async () => {
        other.props.onPress();
    });
    expect(navigate).toHaveBeenCalledWith('s-b');
    expect(closed).toHaveLength(1);

    const spacesButton = (renderer.root as any).find(
        (node: { type: unknown; props?: any }) => node.type === 'Pressable' && node.props?.accessibilityLabel === 'Spaces, every workspace',
    );
    await TestRenderer.act(async () => {
        spacesButton.props.onPress();
    });
    expect(spaces).toHaveLength(1);
    expect(closed).toHaveLength(2);
    renderer.unmount();
});
