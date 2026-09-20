/**
 * The Panes screen: every pane on this computer, product-owned and never
 * gated on a plugin. One workspace's chips, its tab strip, and the same grid
 * cards the session header's overview uses — plus a clearly separated
 * third-party Applications section fed by the typed host Applications methods.
 * Shells open too: a pane without a session still has its `shell:` route.
 */

import * as React from 'react';
import { ActivityIndicator, Pressable, ScrollView, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Ionicons } from '@expo/vector-icons';
import type { ApplicationLauncher, HerdrTreePane } from '@muxr/contract';
import { sync } from '@/catalog/sync';
import { useHerdrTree } from '@/catalog/store';
import { useDeviceAuthority } from '@/pairing';
import { getCachedConnectionSettings } from '@/connection';
import { Modal } from '@/modal';
import { AgentGlyph } from '@/components/AgentGlyph';
import { Text as StyledText } from '@/components/StyledText';
import { Typography } from '@/constants/Typography';
import { agentLabels, isShellLabels, tabLabel } from '@/herd';
import { agentStatusColor } from '@/herd';
import { rememberPaneSelection, useNavigateToSession } from '@/herd';
import { PaneGridView } from '@/herd/ui';

const VIEW_ONLY = 'View-only devices cannot launch applications';

const stylesheet = StyleSheet.create((theme) => ({
    bar: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 12,
        paddingHorizontal: 12,
        paddingVertical: 8,
        backgroundColor: theme.colors.surface,
    },
    title: { color: theme.colors.text, fontWeight: '600' },
    chips: {
        flexGrow: 0,
        maxHeight: 44,
        backgroundColor: theme.colors.surface,
        borderTopWidth: StyleSheet.hairlineWidth,
        borderTopColor: theme.colors.divider,
    },
    chip: {
        minHeight: 44,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
        paddingHorizontal: 9,
        borderBottomWidth: 2,
        borderBottomColor: 'transparent',
    },
    chipActive: {
        borderBottomColor: theme.colors.accent,
        backgroundColor: theme.colors.surfaceSelected,
    },
    chipText: { fontSize: 11, color: theme.colors.textSecondary },
    chipTextActive: { color: theme.colors.text, fontWeight: '600' },
    appRow: {
        minHeight: 44,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 10,
        paddingHorizontal: 14,
        paddingVertical: 8,
        borderBottomWidth: StyleSheet.hairlineWidth,
        borderBottomColor: theme.colors.divider,
        backgroundColor: theme.colors.surfaceHigh,
    },
    sectionNote: {
        ...Typography.default(),
        fontSize: 11,
        color: theme.colors.textSecondary,
        paddingHorizontal: 16,
        paddingTop: 6,
    },
}));

function chipLabel(workspaceLabel: string | undefined, index: number): string {
    const label = workspaceLabel?.trim() ?? '';
    return label === '' ? `Workspace ${index + 1}` : label;
}

/** Third-party Applications: enabled plugins' global launchers, host-served. */
function ApplicationsSection({ canControl }: { canControl: boolean }): React.JSX.Element {
    const { theme } = useUnistyles();
    const navigate = useNavigateToSession();
    const [items, setItems] = React.useState<ApplicationLauncher[] | null>(null);
    const [pendingId, setPendingId] = React.useState<string | null>(null);
    React.useEffect(() => {
        let cancelled = false;
        sync.request('applications.list', {})
            .then((result) => { if (!cancelled) setItems(result.items); })
            .catch(() => { if (!cancelled) setItems([]); });
        return () => { cancelled = true; };
    }, []);
    if (items === null || items.length === 0) return <View />;
    const launch = (application: ApplicationLauncher) => {
        if (pendingId !== null) return;
        setPendingId(application.id);
        sync.request('applications.launch', { applicationId: application.id })
            .then(async (result) => {
                await sync.refreshHerdTree().catch(() => undefined);
                navigate(result.sessionId);
            })
            .catch((cause: unknown) => {
                Modal.alert('Launch failed', cause instanceof Error ? cause.message : String(cause));
            })
            .finally(() => setPendingId(null));
    };
    return (
        <View style={{ marginTop: 12 }}>
            <View style={{ paddingHorizontal: 16, paddingBottom: 6, gap: 2 }}>
                <StyledText style={{ ...Typography.default('semiBold'), fontSize: 13, color: theme.colors.text }}>Applications</StyledText>
                <StyledText style={{ ...Typography.default(), fontSize: 11, color: theme.colors.textSecondary }}>Third-party · from installed plugins</StyledText>
            </View>
            <View style={{ marginHorizontal: 12, borderRadius: 12, overflow: 'hidden', borderWidth: StyleSheet.hairlineWidth, borderColor: theme.colors.divider }}>
                {items.map((application) => {
                    const busy = pendingId === application.id;
                    return (
                        <Pressable
                            key={application.id}
                            onPress={() => launch(application)}
                            disabled={!canControl || pendingId !== null}
                            accessibilityRole="button"
                            accessibilityLabel={`Launch ${application.title} from ${application.pluginName}`}
                            accessibilityState={{ disabled: !canControl || pendingId !== null, busy }}
                            style={({ pressed }) => [stylesheet.appRow, { opacity: !canControl ? 0.45 : pressed ? 0.7 : 1 }]}
                        >
                            <Ionicons name="flash-outline" size={18} color={theme.colors.textSecondary} />
                            <View style={{ flex: 1, minWidth: 0 }}>
                                <StyledText numberOfLines={1} style={{ ...Typography.default('semiBold'), fontSize: 15, color: theme.colors.text }}>{application.title}</StyledText>
                                <StyledText numberOfLines={1} style={{ ...Typography.default(), fontSize: 12, color: theme.colors.textSecondary }}>{application.pluginName}</StyledText>
                            </View>
                            {busy && <ActivityIndicator size="small" color={theme.colors.textSecondary} />}
                        </Pressable>
                    );
                })}
            </View>
            {!canControl && <StyledText style={stylesheet.sectionNote}>{VIEW_ONLY}</StyledText>}
        </View>
    );
}

export default React.memo(() => {
    const { theme } = useUnistyles();
    const insets = useSafeAreaInsets();
    const router = useRouter();
    const { workspaces, loaded } = useHerdrTree();
    const { authority, loading } = useDeviceAuthority();
    const canControl = authority === 'control' && !loading;
    const navigate = useNavigateToSession();

    // Selection: the focused workspace/tab by default, else the first; a stale
    // selection (closed on the host) falls back the same way.
    const [workspaceId, setWorkspaceId] = React.useState<string | null>(null);
    const [tabId, setTabId] = React.useState<string | null>(null);
    const workspace = workspaces.find((entry) => entry.workspaceId === workspaceId)
        ?? workspaces.find((entry) => entry.focused === true)
        ?? workspaces[0];
    const tabIndex = workspace === undefined ? 0 : workspaces.indexOf(workspace);
    const tabs = workspace?.tabs ?? [];
    const tab = tabs.find((entry) => entry.tabId === tabId) ?? tabs.find((entry) => entry.focused === true) ?? tabs[0];

    React.useEffect(() => {
        void sync.refreshHerdTree().catch(() => undefined);
    }, []);

    const openPane = React.useCallback((pane: HerdrTreePane) => {
        const route = pane.sessionId ?? `shell:${pane.paneId}`;
        if (workspace !== undefined && tab !== undefined) {
            const machineId = getCachedConnectionSettings().machineId;
            rememberPaneSelection({ machineId, workspaceId: workspace.workspaceId, tabId: tab.tabId }, route);
        }
        navigate(route);
    }, [workspace, tab, navigate]);

    const chips = workspace !== undefined && tab !== undefined ? (
        <View>
            {workspaces.length > 1 && (
                <ScrollView horizontal showsHorizontalScrollIndicator={false} keyboardShouldPersistTaps="always" style={stylesheet.chips} contentContainerStyle={{ alignItems: 'center', paddingHorizontal: 8 }}>
                    {workspaces.map((entry, index) => {
                        const active = entry.workspaceId === workspace.workspaceId;
                        return (
                            <Pressable
                                key={entry.workspaceId}
                                onPress={() => { setWorkspaceId(entry.workspaceId); setTabId(null); }}
                                accessibilityRole="button"
                                accessibilityLabel={`Workspace ${chipLabel(entry.label, index)}`}
                                accessibilityState={{ selected: active }}
                                style={[stylesheet.chip, active && stylesheet.chipActive, { opacity: 0.9 }]}
                            >
                                <StyledText numberOfLines={1} style={[stylesheet.chipText, active && stylesheet.chipTextActive]}>{chipLabel(entry.label, index)}</StyledText>
                            </Pressable>
                        );
                    })}
                </ScrollView>
            )}
            {tabs.length > 0 && (
                <ScrollView horizontal showsHorizontalScrollIndicator={false} keyboardShouldPersistTaps="always" style={stylesheet.chips} contentContainerStyle={{ alignItems: 'center', paddingHorizontal: 8 }}>
                    {tabs.map((entry, index) => {
                        const active = entry.tabId === tab.tabId;
                        const single = entry.panes.length === 1 ? entry.panes[0] : undefined;
                        const singleLabels = single === undefined ? undefined : agentLabels(single);
                        const tone = agentStatusColor(entry.agentStatus, theme);
                        const label = tabLabel(entry, index);
                        return (
                            <Pressable
                                key={entry.tabId}
                                onPress={active ? undefined : () => setTabId(entry.tabId)}
                                accessibilityRole="button"
                                accessibilityLabel={`${active ? 'Current tab' : 'Open tab'} ${label}, ${entry.panes.length === 1 ? '1 pane' : `${entry.panes.length} panes`}`}
                                accessibilityState={{ selected: active }}
                                style={[stylesheet.chip, active && stylesheet.chipActive]}
                            >
                                {singleLabels !== undefined
                                    ? <AgentGlyph name={isShellLabels(singleLabels) ? 'shell' : singleLabels.agentKind ?? singleLabels.agentName} size={16} />
                                    : <Ionicons name="grid-outline" size={14} color={theme.colors.textSecondary} />}
                                <StyledText numberOfLines={1} style={[stylesheet.chipText, active && stylesheet.chipTextActive, { color: active ? tone.color : theme.colors.textSecondary }]}>{label}</StyledText>
                                <StyledText style={stylesheet.chipText}>{entry.panes.length === 1 ? '1' : `${entry.panes.length}`}</StyledText>
                            </Pressable>
                        );
                    })}
                </ScrollView>
            )}
        </View>
    ) : null;

    return (
        <View style={{ flex: 1, backgroundColor: theme.colors.groupped.background, paddingTop: insets.top }}>
            <View style={stylesheet.bar}>
                <Pressable onPress={() => router.back()} hitSlop={12} accessibilityRole="button" accessibilityLabel="Back">
                    <Ionicons name="chevron-back" size={22} color={theme.colors.text} />
                </Pressable>
                <View style={{ flex: 1 }}>
                    <Text numberOfLines={1} style={stylesheet.title}>Panes</Text>
                    <Text numberOfLines={1} style={{ color: theme.colors.textSecondary, fontSize: 12 }}>
                        {workspace === undefined ? (loaded ? 'no workspaces' : 'loading…') : tab === undefined ? chipLabel(workspace.label, tabIndex) : `${chipLabel(workspace.label, tabIndex)} · ${tabLabel(tab, tabs.indexOf(tab))}`}
                    </Text>
                </View>
            </View>
            <PaneGridView
                panes={tab?.panes ?? []}
                canClose={false}
                closeReason={canControl ? 'Close panes from the session' : 'View-only devices cannot close panes'}
                onOpen={openPane}
                onClose={() => undefined}
                sessionIdFor={(pane) => pane.sessionId ?? `shell:${pane.paneId}`}
                header={chips}
                footer={<ApplicationsSection canControl={canControl} />}
                emptyText={loaded ? 'No panes in this tab' : 'Loading panes…'}
            />
        </View>
    );
});
