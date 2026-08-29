/**
 * Workspace overview: every tab of the workspace with its panes as live tiles.
 * The top rung of the zoom ladder — pinch closed on a terminal goes pane →
 * tab grid → here; tap a tile to zoom back into that pane's session.
 */

import * as React from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import { router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useUnistyles } from 'react-native-unistyles';
import { Ionicons } from '@expo/vector-icons';
import type { HerdrTreeWorkspace } from '@muxr/contract';
import { sync } from '@/catalog/sync';
import { TerminalPreview } from '@/terminal/ui';
import { AgentGlyph } from '@/components/AgentGlyph';
import { agentKindLabel, agentLabels, agentNameLine, agentStatusColor } from '@/herd';

export default React.memo(function WorkspaceScreen() {
    const { id } = useLocalSearchParams<{ id: string }>();
    const { theme } = useUnistyles();
    const insets = useSafeAreaInsets();
    const [workspace, setWorkspace] = React.useState<HerdrTreeWorkspace | null>(null);

    React.useEffect(() => {
        let cancelled = false;
        const load = (): void => {
            void sync
                .request('herdr.tree', {})
                .then((tree) => {
                    if (!cancelled) setWorkspace(tree.workspaces.find((entry) => entry.workspaceId === id) ?? null);
                })
                .catch(() => undefined);
        };
        load();
        const interval = setInterval(load, 5_000);
        return () => {
            cancelled = true;
            clearInterval(interval);
        };
    }, [id]);

    const label = workspace?.label?.split('/').filter(Boolean).pop() ?? workspace?.label ?? 'workspace';

    return (
        <View style={{ flex: 1, backgroundColor: theme.colors.groupped.background, paddingTop: insets.top }}>
            <View
                style={{
                    flexDirection: 'row',
                    alignItems: 'center',
                    gap: 12,
                    paddingHorizontal: 12,
                    paddingVertical: 8,
                    backgroundColor: theme.colors.surface,
                }}
            >
                <Pressable onPress={() => router.back()} hitSlop={12}>
                    <Ionicons name="chevron-back" size={22} color={theme.colors.text} />
                </Pressable>
                <View style={{ flex: 1 }}>
                    <Text numberOfLines={1} style={{ color: theme.colors.text, fontWeight: '600' }}>
                        {label}
                    </Text>
                    <Text numberOfLines={1} style={{ color: theme.colors.textSecondary, fontSize: 12 }}>
                        all tabs
                    </Text>
                </View>
            </View>
            <ScrollView contentContainerStyle={{ padding: 12, gap: 14 }}>
                {(workspace?.tabs ?? []).map((tab) => {
                    const dot = agentStatusColor(tab.agentStatus, theme);
                    const title = tab.label !== undefined && tab.label !== '' ? tab.label : 'Tab';
                    return (
                        <View key={tab.tabId}>
                            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, paddingBottom: 6 }}>
                                <Ionicons name="folder-open-outline" size={12} color={theme.colors.textSecondary} />
                                <Text style={{ color: theme.colors.textSecondary, fontSize: 12, ...{ fontWeight: '600' } }}>{title}</Text>
                                <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: dot.color }} />
                            </View>
                            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
                                {tab.panes.map((pane) => {
                                    const labels = agentLabels(pane);
                                    if (pane.sessionId === undefined) {
                                        return (
                                            <View
                                                key={pane.paneId}
                                                style={{
                                                    width: '48%',
                                                    height: 110,
                                                    borderRadius: 10,
                                                    backgroundColor: theme.colors.surface,
                                                    alignItems: 'center',
                                                    justifyContent: 'center',
                                                    opacity: 0.4,
                                                }}
                                            >
                                                <Ionicons name="terminal-outline" size={18} color={theme.colors.textSecondary} />
                                                <Text style={{ color: theme.colors.textSecondary, fontSize: 11, marginTop: 4 }}>{labels.agentName}</Text>
                                            </View>
                                        );
                                    }
                                    const paneIdentity = agentNameLine(labels);
                                    return (
                                        <Pressable
                                            key={pane.paneId}
                                            onPress={() => router.push(`/session/${encodeURIComponent(pane.sessionId as string)}`)}
                                            style={({ pressed }) => ({
                                                width: '48%',
                                                borderRadius: 10,
                                                overflow: 'hidden',
                                                backgroundColor: theme.colors.surface,
                                                opacity: pressed ? 0.7 : 1,
                                            })}
                                        >
                                            <View style={{ height: 110 }} pointerEvents="none">
                                                <TerminalPreview sessionId={pane.sessionId} />
                                            </View>
                                            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 8, paddingVertical: 5 }}>
                                                <Text numberOfLines={1} style={{ color: theme.colors.textSecondary, fontSize: 11, flex: 1 }}>
                                                    {labels.taskTitle}
                                                </Text>
                                                {labels.agentKind !== undefined && <>
                                                    <AgentGlyph name={labels.agentKind} size={14} />
                                                    <Text numberOfLines={1} style={{ color: theme.colors.textSecondary, fontSize: 9, fontWeight: '600' }}>
                                                        {agentKindLabel(labels.agentKind)}
                                                    </Text>
                                                </>}
                                            </View>
                                            <Text numberOfLines={1} style={{ color: theme.colors.textSecondary, fontSize: 10, paddingHorizontal: 8, paddingBottom: 5 }}>
                                                {paneIdentity}
                                            </Text>
                                        </Pressable>
                                    );
                                })}
                            </View>
                        </View>
                    );
                })}
                {workspace !== null && workspace.tabs.length === 0 && (
                    <Text style={{ color: theme.colors.textSecondary, textAlign: 'center', marginTop: 40 }}>No tabs in this workspace.</Text>
                )}
            </ScrollView>
        </View>
    );
});
