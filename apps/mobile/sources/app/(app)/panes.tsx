/**
 * The Panes screen: one workspace as a live tree, in the Spaces list's own
 * rows. Each tab is a card headed by its name and pane count; its panes are
 * rows -- kind glyph, name, task (or a shell's directory), status on the
 * right edge. Tap opens a pane, long-press closes it; New pane and New tab
 * live here too. Other workspaces are one tap away in Spaces.
 */

import * as React from 'react';
import { ActivityIndicator, Pressable, ScrollView, View } from 'react-native';
import { useFocusEffect, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Ionicons } from '@expo/vector-icons';
import type { ApplicationLauncher, HerdrTreePane, HerdrTreeTab, HerdrTreeWorkspace } from '@muxr/contract';
import type { ModelMode } from '@/components/OptionSheet';
import { sync } from '@/catalog/sync';
import { useHerdrTree } from '@/catalog/store';
import { useDeviceAuthority } from '@/pairing';
import { getCachedConnectionSettings } from '@/connection';
import { Modal } from '@/modal';
import { Text } from '@/components/StyledText';
import { SectionLabel } from '@/components/ui';
import { Typography } from '@/constants/Typography';
import { agentLabels, isShellLabels, tabLabel, workspaceName } from '@/herd';
import { rememberPaneSelection, renameInHerdr, renamePane, showNameActions, useNavigateToSession, useUnseenDoneSessionIds } from '@/herd';
import { AgentPickerSheet, AgentRow, WorkspaceTreeSheet, paneTaskLine, shellPath } from '@/herd/ui';

const VIEW_ONLY = 'View-only devices cannot change panes';

const stylesheet = StyleSheet.create((theme) => ({
    bar: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 12,
        paddingHorizontal: 12,
        paddingVertical: 8,
    },
    card: {
        backgroundColor: theme.colors.surfaceHigh,
        borderRadius: 12,
        marginHorizontal: 16,
        marginTop: 10,
        overflow: 'hidden',
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: theme.colors.divider,
    },
    tabHeader: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        minHeight: 44,
        paddingLeft: 16,
        borderBottomWidth: StyleSheet.hairlineWidth,
        borderBottomColor: theme.colors.divider,
    },
    tabTitle: {
        ...Typography.default('semiBold'),
        flexShrink: 1,
        fontSize: 15,
        color: theme.colors.text,
    },
    meta: {
        ...Typography.default(),
        fontSize: 12,
        color: theme.colors.textSecondary,
    },
    plainRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 10,
        minHeight: 48,
        paddingHorizontal: 16,
    },
    note: {
        ...Typography.default(),
        fontSize: 12,
        color: theme.colors.textSecondary,
        paddingHorizontal: 20,
        paddingTop: 8,
    },
}));

/** The pane a new pane or tab hangs off: the desk's focused one, else the first that opens. */
function anchorOf(panes: readonly HerdrTreePane[]): string | undefined {
    return (panes.find((pane) => pane.focused && pane.sessionId !== undefined) ?? panes.find((pane) => pane.sessionId !== undefined))?.sessionId;
}

function subtitleOf(pane: HerdrTreePane): string | undefined {
    const labels = agentLabels(pane);
    if (isShellLabels(labels)) return shellPath(pane.cwd);
    return pane.agentStatus === 'blocked' ? ['Needs you', paneTaskLine(pane)].filter(Boolean).join(' · ') : undefined;
}

/** Plugin launchers, when any are installed: small, below the tree. */
function Applications({ canControl, anchor }: { canControl: boolean; anchor: string | undefined }): React.JSX.Element | null {
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
    if (items === null || items.length === 0) return null;
    const launch = (application: ApplicationLauncher) => {
        if (pendingId !== null) return;
        setPendingId(application.id);
        sync.request('applications.launch', { applicationId: application.id, ...(anchor === undefined ? {} : { sessionId: anchor }) })
            .then(async (result) => {
                await sync.refreshHerdTree().catch(() => undefined);
                navigate(result.sessionId);
            })
            .catch((cause: unknown) => Modal.alert('Launch failed', cause instanceof Error ? cause.message : String(cause)))
            .finally(() => setPendingId(null));
    };
    return (
        <View style={{ marginTop: 20 }}>
            <View style={{ paddingHorizontal: 20, paddingBottom: 2 }}><SectionLabel>From plugins</SectionLabel></View>
            <View style={stylesheet.card}>
                {items.map((application, index) => (
                    <Pressable
                        key={application.id}
                        onPress={() => launch(application)}
                        disabled={!canControl || pendingId !== null}
                        accessibilityRole="button"
                        accessibilityLabel={`Open ${application.title} in a new tab, from ${application.pluginName}`}
                        accessibilityState={{ disabled: !canControl || pendingId !== null, busy: pendingId === application.id }}
                        style={({ pressed }) => [stylesheet.plainRow, index > 0 && { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: theme.colors.divider }, { opacity: !canControl ? 0.45 : pressed ? 0.6 : 1 }]}
                    >
                        <Ionicons name="extension-puzzle-outline" size={16} color={theme.colors.textSecondary} />
                        <Text numberOfLines={1} style={{ ...Typography.default(), flex: 1, fontSize: 14, color: theme.colors.text }}>{application.title}</Text>
                        {application.pluginName !== application.title && <Text numberOfLines={1} style={[stylesheet.meta, { maxWidth: 120 }]}>{application.pluginName}</Text>}
                        {pendingId === application.id && <ActivityIndicator size="small" color={theme.colors.textSecondary} />}
                    </Pressable>
                ))}
            </View>
        </View>
    );
}

const TabCard = React.memo(function TabCard(props: {
    tab: HerdrTreeTab;
    index: number;
    canControl: boolean;
    unseenDone: ReadonlySet<string>;
    onOpen: (tab: HerdrTreeTab, sessionId: string) => void;
    onPaneActions: (pane: HerdrTreePane) => void;
    onNewPane: (tab: HerdrTreeTab) => void;
}): React.JSX.Element {
    const { theme } = useUnistyles();
    const { tab } = props;
    const label = tabLabel(tab, props.index);
    const count = tab.panes.length === 1 ? '1 pane' : `${tab.panes.length} panes`;
    const canSplit = props.canControl && anchorOf(tab.panes) !== undefined;
    const open = React.useCallback((sessionId: string) => props.onOpen(tab, sessionId), [props, tab]);
    return (
        <View style={stylesheet.card}>
            <Pressable
                style={stylesheet.tabHeader}
                onLongPress={props.canControl ? () => showNameActions(label, () => void renameInHerdr('tab', tab.tabId, label)) : undefined}
                accessibilityRole="header"
                accessibilityLabel={`${label}, ${count}${tab.focused ? ', current tab' : ''}`}
                accessibilityHint={props.canControl ? 'Long-press to rename' : undefined}
            >
                <Text numberOfLines={1} style={stylesheet.tabTitle}>{label}</Text>
                {tab.focused && <Text style={[stylesheet.meta, { color: theme.colors.textLink }]}>Current</Text>}
                <Text style={[stylesheet.meta, { marginLeft: 'auto' }]}>{count}</Text>
                <Pressable
                    onPress={() => props.onNewPane(tab)}
                    disabled={!canSplit}
                    accessibilityRole="button"
                    accessibilityLabel={`New pane in ${label}${props.canControl ? '' : `, unavailable: ${VIEW_ONLY}`}`}
                    accessibilityState={{ disabled: !canSplit }}
                    style={({ pressed }) => ({ width: 44, height: 44, alignItems: 'center', justifyContent: 'center', opacity: !canSplit ? 0.35 : pressed ? 0.5 : 1 })}
                >
                    <Ionicons name="add" size={20} color={theme.colors.textSecondary} />
                </Pressable>
            </Pressable>
            {tab.panes.map((pane, index) => (
                <AgentRow
                    key={pane.paneId}
                    pane={pane}
                    first={index === 0}
                    onLongPress={props.onPaneActions}
                    onNavigatePane={open}
                    compact={false}
                    selected={false}
                    canClose={props.canControl}
                    unseenDone={pane.sessionId !== undefined && props.unseenDone.has(pane.sessionId)}
                    subtitle={subtitleOf(pane)}
                />
            ))}
        </View>
    );
});

export default React.memo(() => {
    const { theme } = useUnistyles();
    const insets = useSafeAreaInsets();
    const router = useRouter();
    const { workspaces, loaded } = useHerdrTree();
    const { authority, loading } = useDeviceAuthority();
    const canControl = authority === 'control' && !loading;
    const navigate = useNavigateToSession();
    const unseenDone = useUnseenDoneSessionIds();
    const [spacesOpen, setSpacesOpen] = React.useState(false);
    const [newPaneTab, setNewPaneTab] = React.useState<HerdrTreeTab | null>(null);

    // The desk's focused workspace, else the first.
    const workspace: HerdrTreeWorkspace | undefined = workspaces.find((entry) => entry.focused) ?? workspaces[0];
    const others = workspaces.length - (workspace === undefined ? 0 : 1);
    const workspaceAnchor = workspace === undefined ? undefined : anchorOf(workspace.tabs.flatMap((tab) => tab.panes));

    const refresh = React.useCallback(() => sync.refreshHerdTree().catch(() => undefined), []);
    // Live while on screen: the same five-second read Home's Spaces list makes.
    useFocusEffect(React.useCallback(() => {
        void refresh();
        const interval = setInterval(() => void refresh(), 5_000);
        return () => clearInterval(interval);
    }, [refresh]));

    const openPane = React.useCallback((tab: HerdrTreeTab, sessionId: string) => {
        if (workspace !== undefined) {
            rememberPaneSelection({ machineId: getCachedConnectionSettings().machineId, workspaceId: workspace.workspaceId, tabId: tab.tabId }, sessionId);
        }
        navigate(sessionId);
    }, [workspace, navigate]);

    const closePane = React.useCallback((pane: HerdrTreePane) => {
        const sessionId = pane.sessionId;
        if (sessionId === undefined) return;
        Modal.alert(`Close ${agentLabels(pane).title}?`, 'Its running process stops. If it is the last pane of its tab, nothing closes.', [
            { text: 'Cancel', style: 'cancel' },
            {
                text: 'Close',
                style: 'destructive',
                onPress: () => {
                    sync.request('pane.close', { sessionId })
                        .catch((cause: unknown) => {
                            if ((cause as { code?: string }).code === 'pane-close-would-widen') {
                                Modal.alert('Keep this pane', 'It is the last pane of its tab. Close the tab or the workspace from Spaces instead.');
                            } else {
                                Modal.alert('Close failed', cause instanceof Error ? cause.message : String(cause));
                            }
                        })
                        .finally(() => void refresh());
                },
            },
        ]);
    }, [refresh]);

    const paneActions = React.useCallback((pane: HerdrTreePane) => {
        showNameActions(agentLabels(pane).title, () => void renamePane(pane),
            pane.sessionId === undefined ? undefined : { label: 'Close pane', onPress: () => closePane(pane) });
    }, [closePane]);

    const splitPane = React.useCallback((option: ModelMode) => {
        const anchor = newPaneTab === null ? undefined : anchorOf(newPaneTab.panes);
        setNewPaneTab(null);
        if (anchor === undefined) return;
        const kind = option.agentKind;
        sync.request('pane.split', { sessionId: anchor, direction: 'right', ...(kind === undefined ? {} : { kind }) })
            .then(async (result) => {
                await refresh();
                if (result.sessionId !== undefined) navigate(result.sessionId);
            })
            .catch(async (cause: unknown) => {
                Modal.alert('New pane failed', cause instanceof Error ? cause.message : String(cause));
                await refresh();
            });
    }, [newPaneTab, navigate, refresh]);

    const newTab = React.useCallback(() => {
        if (workspaceAnchor === undefined) return;
        sync.request('tab.create', { sessionId: workspaceAnchor })
            .then(async (result) => {
                await refresh();
                if (result?.sessionId !== undefined) navigate(result.sessionId);
            })
            .catch(async (cause: unknown) => {
                Modal.alert('New tab failed', cause instanceof Error ? cause.message : String(cause));
                await refresh();
            });
    }, [workspaceAnchor, navigate, refresh]);

    const canCreateTab = canControl && workspaceAnchor !== undefined;
    return (
        <View style={{ flex: 1, backgroundColor: theme.colors.groupped.background, paddingTop: insets.top }}>
            <View style={stylesheet.bar}>
                <Pressable onPress={() => router.back()} hitSlop={12} accessibilityRole="button" accessibilityLabel="Back">
                    <Ionicons name="chevron-back" size={22} color={theme.colors.text} />
                </Pressable>
                <View style={{ flex: 1, minWidth: 0 }}>
                    <Text numberOfLines={1} style={{ ...Typography.default('semiBold'), fontSize: 17, color: theme.colors.text }}>Panes</Text>
                    <Text numberOfLines={1} style={stylesheet.meta}>
                        {workspace === undefined ? (loaded ? 'No workspaces' : 'Loading…') : workspaceName(workspace)}
                    </Text>
                </View>
                <Pressable
                    onPress={() => setSpacesOpen(true)}
                    hitSlop={8}
                    accessibilityRole="button"
                    accessibilityLabel={others > 0 ? `Spaces, ${others} more ${others === 1 ? 'workspace' : 'workspaces'}` : 'Spaces'}
                    style={({ pressed }) => ({ minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 4, opacity: pressed ? 0.6 : 1 })}
                >
                    <Ionicons name="albums-outline" size={18} color={theme.colors.textLink} />
                    <Text style={{ ...Typography.default('semiBold'), fontSize: 15, color: theme.colors.textLink }}>Spaces</Text>
                </Pressable>
            </View>
            <ScrollView contentContainerStyle={{ paddingBottom: insets.bottom + 24 }}>
                {workspace === undefined && (
                    <Text style={[stylesheet.note, { textAlign: 'center', paddingVertical: 32 }]}>{loaded ? 'No workspaces on this computer yet' : 'Loading panes…'}</Text>
                )}
                {workspace?.tabs.map((tab, index) => (
                    <TabCard
                        key={tab.tabId}
                        tab={tab}
                        index={index}
                        canControl={canControl}
                        unseenDone={unseenDone}
                        onOpen={openPane}
                        onPaneActions={paneActions}
                        onNewPane={setNewPaneTab}
                    />
                ))}
                {workspace !== undefined && (
                    <Pressable
                        onPress={newTab}
                        disabled={!canCreateTab}
                        accessibilityRole="button"
                        accessibilityLabel={`New tab${canControl ? '' : `, unavailable: ${VIEW_ONLY}`}`}
                        accessibilityState={{ disabled: !canCreateTab }}
                        style={({ pressed }) => [stylesheet.card, stylesheet.plainRow, { opacity: !canCreateTab ? 0.45 : pressed ? 0.6 : 1 }]}
                    >
                        <Ionicons name="add" size={18} color={theme.colors.textSecondary} />
                        <Text style={{ ...Typography.default(), fontSize: 14, color: theme.colors.text }}>New tab</Text>
                    </Pressable>
                )}
                {workspace !== undefined && !canControl && <Text style={stylesheet.note}>{VIEW_ONLY}</Text>}
                {workspace !== undefined && <Applications canControl={canControl} anchor={workspaceAnchor} />}
            </ScrollView>
            <AgentPickerSheet visible={newPaneTab !== null} title="New pane" onSelect={splitPane} onClose={() => setNewPaneTab(null)} />
            <WorkspaceTreeSheet visible={spacesOpen} onClose={() => setSpacesOpen(false)} />
        </View>
    );
});
