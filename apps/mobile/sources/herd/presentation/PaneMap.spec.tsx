import { expect, it, vi } from 'vitest';
import React from 'react';
import TestRenderer from 'react-test-renderer';

vi.mock('react-native', () => ({
    View: 'View',
    Text: 'Text',
    Pressable: 'Pressable',
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
const request = vi.hoisted(() => vi.fn());
vi.mock('@/catalog/sync', () => ({ sync: { request } }));
// sessionUtils only needs the Session type from the catalog barrel; loading
// the barrel itself pulls native modules the node runner cannot parse. The
// text module reads persisted settings the same way herdTree.spec stubs it.
vi.mock('@/catalog', () => ({}));
vi.mock('@/catalog/application/persistence', () => ({ loadSettings: () => ({ settings: {}, version: null }) }));

// This resolves the mocked modules, so it must stay below the vi.mock calls.
import { PaneMap } from './PaneMap';
import type { HerdrTreePane, HerdrTreeTab } from '@trymuxr/contract';

function pane(paneId: string, title: string): HerdrTreePane {
    return {
        paneId, tabId: 't', agentName: title, taskTitle: `${title} task`,
        agentStatus: 'idle', promptable: true, focused: false, sessionId: `s-${paneId}`,
    };
}

function tab(): HerdrTreeTab {
    return {
        tabId: 't', focused: true, agentStatus: 'idle',
        panes: [pane('a', 'left'), pane('b', 'right')],
    };
}

/** A desk with two panes split left/right, answered from the layout request. */
function splitLayout() {
    return { layout: {
        area: { x: 0, y: 0, width: 120, height: 40 },
        panes: [
            { paneId: 'a', rect: { x: 0, y: 0, width: 60, height: 40 } },
            { paneId: 'b', rect: { x: 60, y: 0, width: 60, height: 40 } },
        ],
    } };
}

async function renderMap(props?: Partial<React.ComponentProps<typeof PaneMap>>) {
    request.mockResolvedValue(splitLayout());
    const opened: HerdrTreePane[] = [];
    let renderer!: ReturnType<typeof TestRenderer.create>;
    await TestRenderer.act(async () => {
        renderer = TestRenderer.create(
            <PaneMap
                tab={tab()}
                currentPaneId="a"
                pendingRequestIds={new Set<string>()}
                canClose={false}
                onOpen={(target) => { opened.push(target); }}
                onClose={() => undefined}
                {...props}
            />,
        );
    });
    // The map measures its own width before it draws any tile.
    const measurer = (renderer.root as any).find(
        (node: { type: unknown; props?: any }) => typeof node.props?.onLayout === 'function',
    );
    await TestRenderer.act(async () => {
        measurer.props.onLayout({ nativeEvent: { layout: { width: 300 } } });
        await Promise.resolve();
    });
    return { renderer, opened };
}

function tiles(renderer: ReturnType<typeof TestRenderer.create>) {
    return (renderer.root as any).findAll(
        (node: { type: unknown; props?: any }) => node.type === 'View' && node.props?.style?.position === 'absolute',
    );
}

function tileButtons(renderer: ReturnType<typeof TestRenderer.create>) {
    return (renderer.root as any).findAll(
        (node: { type: unknown; props?: any }) => node.type === 'Pressable'
            && typeof node.props?.accessibilityLabel === 'string'
            && /pane/i.test(node.props.accessibilityLabel),
    );
}

/*
 * The pane bottom sheet must draw the tab's real split, not a list: two panes
 * split left/right on the desk draw as two tiles side by side, the open one
 * outlined, and tapping the other tile opens exactly that pane.
 */
it('draws the desk split side by side and opens the tapped pane', async () => {
    const { renderer, opened } = await renderMap();
    const [left, right] = tiles(renderer);
    expect(tiles(renderer)).toHaveLength(2);
    expect(left!.props.style.left).toBe(2); // half the tile gap
    expect(right!.props.style.left).toBeGreaterThan(140);
    expect(right!.props.style.left + right!.props.style.width).toBeLessThanOrEqual(302);

    const buttons = tileButtons(renderer);
    expect(buttons).toHaveLength(2);
    const [current, other] = buttons;
    expect(current!.props.accessibilityLabel).toMatch(/^Current pane, left/);
    expect(current!.props.accessibilityState).toMatchObject({ selected: true });
    expect(other!.props.accessibilityLabel).toMatch(/^Open pane, right/);

    await TestRenderer.act(async () => {
        other!.props.onPress();
    });
    expect(opened.map((target) => target.paneId)).toEqual(['b']);
    renderer.unmount();
});

/*
 * When the geometry no longer matches the tab (a stale read) the map must not
 * draw a wrong split: it stacks the panes full width, and every pane stays
 * selectable.
 */
it('stacks full width when the layout no longer matches, keeping every pane tappable', async () => {
    request.mockResolvedValueOnce({ layout: {
        area: { x: 0, y: 0, width: 120, height: 40 },
        panes: [{ paneId: 'zzz', rect: { x: 0, y: 0, width: 120, height: 40 } }],
    } });
    const opened: HerdrTreePane[] = [];
    let renderer!: ReturnType<typeof TestRenderer.create>;
    await TestRenderer.act(async () => {
        renderer = TestRenderer.create(
            <PaneMap tab={tab()} pendingRequestIds={new Set<string>()} canClose={false} onOpen={(target) => { opened.push(target); }} onClose={() => undefined} />,
        );
    });
    const measurer = (renderer.root as any).find((node: { type: unknown; props?: any }) => typeof node.props?.onLayout === 'function');
    await TestRenderer.act(async () => {
        measurer.props.onLayout({ nativeEvent: { layout: { width: 300 } } });
        await Promise.resolve();
    });
    const stacked = tiles(renderer);
    expect(stacked).toHaveLength(2);
    for (const tile of stacked) {
        expect(tile.props.style.left).toBe(2); // half the tile gap
        expect(tile.props.style.width).toBeGreaterThan(290);
    }
    expect(stacked[1]!.props.style.top).toBeGreaterThan(stacked[0]!.props.style.top);

    for (const button of tileButtons(renderer)) {
        await TestRenderer.act(async () => {
            button.props.onPress();
        });
    }
    expect(opened.map((target) => target.paneId).sort()).toEqual(['a', 'b']);
    renderer.unmount();
});
