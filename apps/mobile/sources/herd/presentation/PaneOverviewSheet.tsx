/**
 * The pane overview: one deliberate sheet over the session, opened from the
 * header's pane counter. It draws the tab as the desk lays it out -- a
 * mini-map of the real split -- with the pane open here outlined. Tap a tile
 * to switch; long-press or its × closes; the split actions act on the
 * outlined pane. The tab row above shows the workspace's other tabs' layouts.
 * Refreshes the shared tree on open and after each mutation; no poller.
 */

import * as React from 'react';
import { Pressable, ScrollView, View } from 'react-native';
import { ScopedTheme, useUnistyles } from 'react-native-unistyles';
import { Ionicons } from '@expo/vector-icons';
import type { HerdrTreePane } from '@muxr/contract';
import { Text } from '@/components/StyledText';
import { OptionSheet, type ModelMode } from '@/components/OptionSheet';
import { Typography } from '@/constants/Typography';
import { Modal } from '@/modal';
import { sync } from '@/catalog/sync';
import { useHerdrTree } from '@/catalog/store';
import { useDeviceAuthority } from '@/pairing';
import { getCachedConnectionSettings } from '@/connection';
import { agentLabels, herdrTabForSession, tabLabel } from '../domain/agentPresentation';
import { agentStatusColor } from '../application/sessionUtils';
import { rememberPaneSelection, useNavigateToSession } from '../application/useNavigateToSession';
import { AgentPickerSheet } from './AgentPickerSheet';
import { PaneMap } from './PaneMap';

const VIEW_ONLY = 'View-only devices cannot create or close panes';

function errorMessage(cause: unknown): string {
    return cause instanceof Error ? cause.message : String(cause);
}

export function PaneOverviewSheet(props: { visible: boolean; sessionId: string; onClose: () => void }): React.JSX.Element {
    const { theme } = useUnistyles();
    const { workspaces, loaded } = useHerdrTree();
    const { authority, loading: authorityLoading } = useDeviceAuthority();
    const canMutate = authority === 'control' && !authorityLoading;
    const navigate = useNavigateToSession();
    const located = herdrTabForSession(workspaces, props.sessionId);
    const tabs = located?.workspace.tabs ?? [];
    const [viewedTabId, setViewedTabId] = React.useState<string | null>(null);
    const tab = tabs.find((entry) => entry.tabId === viewedTabId) ?? located?.tab;
    // The outlined pane: the one open here, else (another tab) the pane the desk has focused there.
    const openable = tab?.panes.filter((pane) => pane.sessionId !== undefined) ?? [];
    const target = openable.find((pane) => pane.sessionId === props.sessionId)
        ?? openable.find((pane) => pane.focused)
        ?? openable[0];
    const [pending, setPending] = React.useState<ReadonlySet<string>>(() => new Set());
    const [splitDirection, setSplitDirection] = React.useState<'right' | 'down' | null>(null);

    // Fresh tree on open, back on this pane's own tab.
    React.useEffect(() => {
        if (!props.visible) { setSplitDirection(null); setViewedTabId(null); return; }
        void sync.refreshHerdTree().catch(() => undefined);
    }, [props.visible]);
    const refresh = React.useCallback(() => sync.refreshHerdTree().catch(() => undefined), []);

    const close = props.onClose;
    const openPane = React.useCallback((pane: HerdrTreePane) => {
        if (pane.sessionId === undefined || located === undefined) return;
        const machineId = getCachedConnectionSettings().machineId;
        rememberPaneSelection({ machineId, workspaceId: located.workspace.workspaceId, tabId: pane.tabId }, pane.sessionId);
        close();
        if (pane.sessionId !== props.sessionId) navigate(pane.sessionId);
    }, [located, props.sessionId, navigate, close]);

    const closePane = React.useCallback((pane: HerdrTreePane) => {
        const sessionId = pane.sessionId;
        if (sessionId === undefined) return;
        const labels = agentLabels(pane);
        const siblings = tab?.panes.filter((entry) => entry.sessionId !== undefined) ?? [];
        Modal.alert(`Close ${labels.title}?`, 'Its running process stops. If it is the last pane of its tab, nothing closes.', [
            { text: 'Cancel', style: 'cancel' },
            {
                text: 'Close',
                style: 'destructive',
                onPress: () => {
                    setPending((current) => new Set([...current, pane.paneId]));
                    sync.request('pane.close', { sessionId })
                        .then(async () => {
                            await refresh();
                            if (sessionId !== props.sessionId) return;
                            // The open pane is gone: the next tile, else the previous one.
                            const remaining = siblings.filter((entry) => entry.sessionId !== sessionId);
                            const index = siblings.findIndex((entry) => entry.sessionId === sessionId);
                            const next = remaining[index] ?? remaining[remaining.length - 1];
                            close();
                            if (next?.sessionId !== undefined) navigate(next.sessionId);
                        })
                        .catch(async (cause: unknown) => {
                            const code = (cause as { code?: string }).code;
                            if (code === 'pane-close-would-widen') {
                                Modal.alert('Keep this pane', 'It is the last pane of its tab. Close the tab or the workspace from the spaces list instead.');
                            } else {
                                Modal.alert('Close failed', errorMessage(cause));
                            }
                            await refresh();
                        })
                        .finally(() => setPending((current) => { const next = new Set(current); next.delete(pane.paneId); return next; }));
                },
            },
        ]);
    }, [tab, props.sessionId, navigate, close, refresh]);

    const splitPane = React.useCallback((option: ModelMode) => {
        const direction = splitDirection;
        const anchor = target?.sessionId;
        setSplitDirection(null);
        if (direction === null || anchor === undefined) return;
        const kind = option.agentKind;
        sync.request('pane.split', { sessionId: anchor, direction, ...(kind === undefined ? {} : { kind }) })
            .then(async (result) => {
                await refresh();
                // An acknowledged session opens; a bare pane id stays on the
                // map, where the refreshed tree shows what it became.
                if (result.sessionId === undefined) return;
                close();
                navigate(result.sessionId);
            })
            .catch(async (cause: unknown) => {
                Modal.alert('New pane failed', errorMessage(cause));
                await refresh();
            });
    }, [splitDirection, target, navigate, close, refresh]);

    // "New pane" once, then where: the words stay whole on a narrow phone.
    const splitButton = (direction: 'right' | 'down', label: string, icon: 'arrow-forward' | 'arrow-down') => {
        const disabled = !canMutate || target === undefined;
        return (
            <Pressable
                onPress={() => setSplitDirection(direction)}
                disabled={disabled}
                accessibilityRole="button"
                accessibilityLabel={`${direction === 'right' ? 'New pane to the right' : 'New pane below'}${canMutate ? '' : `, unavailable: ${VIEW_ONLY}`}`}
                accessibilityState={{ disabled }}
                style={({ pressed }) => ({ flex: 1, minHeight: 44, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, paddingHorizontal: 8, borderRadius: 12, backgroundColor: theme.colors.surfaceHigh, opacity: disabled ? 0.45 : pressed ? 0.6 : 1 })}
            >
                <Ionicons name={icon} size={15} color={theme.colors.textSecondary} />
                <Text numberOfLines={1} style={{ ...Typography.default('semiBold'), flexShrink: 1, fontSize: 14, color: theme.colors.text }}>{label}</Text>
            </Pressable>
        );
    };

    const tabRow = (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingBottom: 10 }}>
            {tabs.length > 1 ? (
                <ScrollView horizontal showsHorizontalScrollIndicator={false} keyboardShouldPersistTaps="always" style={{ flex: 1 }} contentContainerStyle={{ gap: 6, alignItems: 'center' }}>
                    {tabs.map((entry, index) => {
                        const active = entry.tabId === tab?.tabId;
                        const here = entry.tabId === located?.tab.tabId;
                        const tone = agentStatusColor(entry.agentStatus, theme);
                        const label = tabLabel(entry, index);
                        const count = entry.panes.length === 1 ? '1 pane' : `${entry.panes.length} panes`;
                        return (
                            <Pressable
                                key={entry.tabId}
                                onPress={() => setViewedTabId(entry.tabId)}
                                accessibilityRole="button"
                                accessibilityState={{ selected: active }}
                                accessibilityLabel={`${label}, ${count}${here ? ', this tab' : ''}`}
                                style={({ pressed }) => ({ minHeight: 36, flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 12, borderRadius: 18, backgroundColor: active ? theme.colors.surfaceSelected : 'transparent', borderWidth: 1, borderColor: active ? theme.colors.surfaceSelected : theme.colors.divider, opacity: pressed ? 0.6 : 1 })}
                            >
                                {(entry.agentStatus === 'blocked' || entry.agentStatus === 'working') && <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: tone.color }} />}
                                <Text numberOfLines={1} style={{ ...Typography.default(active ? 'semiBold' : 'regular'), maxWidth: 160, fontSize: 13, color: active ? theme.colors.text : theme.colors.textSecondary }}>{label}</Text>
                                <Text style={{ ...Typography.default(), fontSize: 12, color: theme.colors.textSecondary }}>{entry.panes.length}</Text>
                            </Pressable>
                        );
                    })}
                </ScrollView>
            ) : (
                <Text numberOfLines={1} style={{ ...Typography.default('semiBold'), flex: 1, minWidth: 0, fontSize: 15, color: theme.colors.text }}>
                    {tab === undefined ? 'Panes' : tabLabel(tab, tabs.indexOf(tab))}
                </Text>
            )}
            <Pressable onPress={close} accessibilityRole="button" accessibilityLabel="Done" style={({ pressed }) => ({ minHeight: 44, paddingHorizontal: 8, alignItems: 'center', justifyContent: 'center', opacity: pressed ? 0.6 : 1 })}>
                <Text style={{ ...Typography.default('semiBold'), color: theme.colors.textLink }}>Done</Text>
            </Pressable>
        </View>
    );

    // A sheet over the session paints from the dark surface whatever the app
    // is set to; the scope sits here, in this sheet's own render, so what it
    // mounts on its own state (the agent picker, pending tiles) reads it too.
    if (splitDirection !== null) {
        return (
            <ScopedTheme name="dark">
                <AgentPickerSheet
                    visible={props.visible}
                    title={splitDirection === 'right' ? 'New pane to the right' : 'New pane below'}
                    onSelect={splitPane}
                    onClose={() => setSplitDirection(null)}
                />
            </ScopedTheme>
        );
    }
    return (
        <ScopedTheme name="dark">
        <OptionSheet
            visible={props.visible}
            title=""
            options={[]}
            onSelect={() => undefined}
            onClose={close}
            maxWidth={640}
            body={(
                <View style={{ paddingHorizontal: 16, paddingBottom: 4 }}>
                    {tabRow}
                    {tab === undefined || tab.panes.length === 0
                        ? <Text style={{ ...Typography.default(), color: theme.colors.textSecondary, textAlign: 'center', paddingVertical: 32 }}>{loaded ? 'No panes in this tab' : 'Loading panes…'}</Text>
                        : (
                            <PaneMap
                                tab={tab}
                                currentPaneId={target?.paneId}
                                pendingPaneIds={pending}
                                canClose={canMutate}
                                onOpen={openPane}
                                onClose={closePane}
                            />
                        )}
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingTop: 12 }}>
                        <Text numberOfLines={1} style={{ ...Typography.default(), fontSize: 13, color: theme.colors.textSecondary }}>New pane</Text>
                        {splitButton('right', 'Right', 'arrow-forward')}
                        {splitButton('down', 'Below', 'arrow-down')}
                    </View>
                    {!canMutate && <Text style={{ ...Typography.default(), fontSize: 11, color: theme.colors.textSecondary, paddingTop: 6 }}>{VIEW_ONLY}</Text>}
                </View>
            )}
        />
        </ScopedTheme>
    );
}
