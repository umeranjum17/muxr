/**
 * Multi-pane grid: one tab's split layout as live terminal tiles.
 *
 * The multiplexing payoff -- a workspace tab with pi + claude + codex in
 * splits shows every pane at once, each an observe-mode live terminal. Tapping
 * a tile with an agent opens full control of that session.
 *
 * Layout rects come from herdr in terminal cells; we normalize by the tab's
 * area into percentages so tiles line up with what the desk actually shows.
 */

import * as React from 'react';
import { Pressable, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { useRouter } from 'expo-router';
import { Text } from '@/components/StyledText';
import { StatusDot } from '@/components/StatusDot';
import { ACCENT } from '@/components/AgentGlyph';
import { TerminalPreview } from '@/terminal/ui';
import { sync } from '@/catalog/sync';
import { agentStatusColor, type AgentLifecycleStatus } from '../application/sessionUtils';
import { agentLabels } from '../domain/agentPresentation';
import type { HerdrTreePane, HerdrTreeTab } from '@muxr/contract';

const POLL_MS = 4_000;

interface LayoutPane {
    paneId: string;
    focused: boolean;
    rect: { x: number; y: number; width: number; height: number };
}

export const PaneGridView = React.memo((props: { tabId: string }) => {
    const { theme } = useUnistyles();
    const router = useRouter();
    const [tab, setTab] = React.useState<HerdrTreeTab | undefined>(undefined);
    const [layout, setLayout] = React.useState<LayoutPane[] | undefined>(undefined);
    const [area, setArea] = React.useState<{ x: number; y: number; width: number; height: number } | undefined>(undefined);
    const [workspaceLabel, setWorkspaceLabel] = React.useState<string | undefined>(undefined);
    const [loading, setLoading] = React.useState(true);

    const load = React.useCallback(async () => {
        try {
            const tree = await sync.request('herdr.tree', {});
            let foundTab: HerdrTreeTab | undefined;
            let foundLabel: string | undefined;
            for (const workspace of tree.workspaces) {
                const match = workspace.tabs.find((candidate) => candidate.tabId === props.tabId);
                if (match !== undefined) {
                    foundTab = match;
                    foundLabel = workspace.label;
                    break;
                }
            }
            setLoading(false);
            if (foundTab === undefined) {
                setTab(undefined);
                setLayout(undefined);
                return;
            }
            setTab(foundTab);
            setWorkspaceLabel(foundLabel);
            try {
                const layoutResult = await sync.request('herdr.layout', { tabId: props.tabId });
                const panes = layoutResult.layout?.panes ?? [];
                const areaRect = layoutResult.layout?.area;
                if (
                    panes.length > 0 &&
                    areaRect !== undefined &&
                    areaRect.width > 0 &&
                    areaRect.height > 0
                ) {
                    setLayout(panes);
                    setArea(areaRect);
                    return;
                }
                setLayout(undefined);
            } catch {
                setLayout(undefined);
            }
        } catch {
            setLoading(false);
            setTab(undefined);
            setLayout(undefined);
        }
    }, [props.tabId]);

    React.useEffect(() => {
        void load();
        const timer = setInterval(() => void load(), POLL_MS);
        return () => clearInterval(timer);
    }, [load]);

    const panes = tab?.panes ?? [];
    const paneById = React.useMemo(() => new Map(panes.map((pane) => [pane.paneId, pane])), [panes]);
    const hasLayout = layout !== undefined && layout.length > 1 && area !== undefined;

    if (panes.length === 0) {
        return (
            <View style={styles.container}>
                <Text style={{ color: theme.colors.textSecondary, textAlign: 'center', marginTop: 24 }}>
                    {loading ? 'Loading this tab…' : `No panes in ${workspaceLabel ?? 'this tab'}`}
                </Text>
            </View>
        );
    }

    if (!hasLayout) {
        // Stack fallback: layout request failed, or the tab is a single pane.
        return (
            <View style={styles.container}>
                {panes.map((pane) => (
                    <PaneTile key={pane.paneId} pane={pane} style={{ height: Math.max(140, 320 / panes.length) }} router={router} />
                ))}
            </View>
        );
    }

    const tiles = layout
        .map((layoutPane) => ({ layoutPane, pane: paneById.get(layoutPane.paneId) }))
        .filter((entry): entry is { layoutPane: LayoutPane; pane: HerdrTreePane } => entry.pane !== undefined);

    return (
        <View style={styles.container}>
            {tiles.map(({ layoutPane, pane }) => {
                const left = ((layoutPane.rect.x - (area?.x ?? 0)) / (area?.width ?? 1)) * 100;
                const top = ((layoutPane.rect.y - (area?.y ?? 0)) / (area?.height ?? 1)) * 100;
                const width = (layoutPane.rect.width / (area?.width ?? 1)) * 100;
                const height = (layoutPane.rect.height / (area?.height ?? 1)) * 100;
                return (
                    <PaneTile
                        key={pane.paneId}
                        pane={pane}
                        style={{
                            position: 'absolute',
                            left: `${left}%`,
                            top: `${top}%`,
                            width: `${width}%`,
                            height: `${height}%`,
                        }}
                        router={router}
                    />
                );
            })}
        </View>
    );
});

const PaneTile = React.memo((props: { pane: HerdrTreePane; style: object; router: ReturnType<typeof useRouter> }) => {
    const { theme } = useUnistyles();
    const { pane, style, router } = props;
    const status: AgentLifecycleStatus = pane.agentStatus ?? 'unknown';
    const color = agentStatusColor(status, theme).color;
    const hasSession = pane.sessionId !== undefined;
    const labels = agentLabels(pane);

    return (
        <Pressable
            onPress={() => {
                if (pane.sessionId !== undefined) router.push(`/session/${encodeURIComponent(pane.sessionId)}`);
            }}
            disabled={!hasSession}
            style={({ pressed }) => [
                {
                    borderRadius: 10,
                    overflow: 'hidden',
                    backgroundColor: theme.colors.surfaceHigh,
                    borderWidth: 1,
                    borderColor: pane.focused ? ACCENT : theme.colors.divider,
                    opacity: pressed && hasSession ? 0.85 : 1,
                },
                style,
            ]}
        >
            <View style={{ flex: 1, backgroundColor: '#000' }}>
                {hasSession ? (
                    <TerminalPreview sessionId={pane.sessionId as string} />
                ) : (
                    <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
                        <Text style={{ color: '#666666', fontSize: 13 }}>{labels.agentName}</Text>
                    </View>
                )}
            </View>
            <View style={{ paddingHorizontal: 8, paddingVertical: 5, gap: 1, backgroundColor: theme.colors.surface }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}>
                    <StatusDot color={color} isPulsing={status === 'working' || status === 'blocked'} size={7} />
                    <Text numberOfLines={1} style={{ color: theme.colors.text, fontSize: 12, fontWeight: '600', flexShrink: 1 }}>
                        {labels.taskTitle}
                    </Text>
                </View>
                <Text numberOfLines={1} style={{ color: theme.colors.textSecondary, fontSize: 10, textTransform: 'capitalize' }}>
                    {labels.agentKind === undefined ? labels.agentName : `${labels.agentName} · ${labels.agentKind}`}
                </Text>
            </View>
        </Pressable>
    );
});

const styles = StyleSheet.create((theme) => ({
    container: {
        flex: 1,
        padding: 8,
        gap: 2,
        backgroundColor: theme.colors.groupped.background,
    },
}));
