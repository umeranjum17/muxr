/**
 * The pane switcher: one full-height sheet over the session, opened from the
 * header's title or its pane counter. The workspace's name heads it, with
 * Spaces and Done beside it; its tabs scroll in their own lane below; the
 * viewed tab's panes are cards with a live preview of each screen, the pane
 * open here outlined. Tap a card to switch; long-press renames or closes, its
 * × closes. The last card adds a pane to the right of or below the outlined
 * one. Refreshes the shared tree on open and after each mutation; previews
 * poll on their own.
 */

import * as React from 'react';
import { Pressable, ScrollView, StyleSheet, View, useWindowDimensions } from 'react-native';
import { ScopedTheme, useUnistyles } from 'react-native-unistyles';
import { Ionicons } from '@expo/vector-icons';
import type { HerdrTreePane } from '@trymuxr/contract';
import { Text } from '@/components/StyledText';
import { AgentGlyph } from '@/components/AgentGlyph';
import { StatusDot } from '@/components/StatusDot';
import { OptionSheet, type ModelMode } from '@/components/OptionSheet';
import { Typography } from '@/constants/Typography';
import { Modal } from '@/modal';
import { sync } from '@/catalog/sync';
import { useHerdrTree, useLiveAgentIds } from '@/catalog/store';
import { useDeviceAuthority } from '@/pairing';
import { getCachedConnectionSettings } from '@/connection';
import { TerminalPreview } from '@/terminal/ui';
import { HERD_STATUS_LABELS, agentLabels, herdrTabForSession, isShellLabels, tabLabel } from '../domain/agentPresentation';
import { workspaceName } from '../domain/herdTree';
import { agentNeedsYou, displayedAgentStatus } from '../domain/recentActivity';
import { agentStatusColor } from '../application/sessionUtils';
import { rememberPaneSelection, useNavigateToSession } from '../application/useNavigateToSession';
import { showPaneActions, showTabActions } from '../application/renameInHerdr';
import { AgentPickerSheet } from './AgentPickerSheet';
import { paneTaskLine } from './PaneMap';

const VIEW_ONLY = 'View-only devices cannot create or close panes';
const SIDE = 16;
const GAP = 10;
/** Below this a card is too narrow for two across; one full-width column instead. */
const TWO_COLUMNS_FROM = 300;

const PaneCard = React.memo(function PaneCard(props: {
    pane: HerdrTreePane;
    width: number;
    previewHeight: number;
    current: boolean;
    pending: boolean;
    pendingRequest: boolean;
    canClose: boolean;
    onOpen: (pane: HerdrTreePane) => void;
    onClose: (pane: HerdrTreePane) => void;
    onLongPress: (pane: HerdrTreePane) => void;
    onPressOut: () => void;
}): React.JSX.Element {
    const { theme } = useUnistyles();
    const { pane } = props;
    const labels = agentLabels(pane);
    const shell = isShellLabels(labels);
    const displayed = displayedAgentStatus(pane.agentStatus, props.pendingRequest);
    const tone = agentStatusColor(displayed, theme);
    const needsYou = agentNeedsYou(pane.agentStatus, props.pendingRequest);
    const task = paneTaskLine(pane);
    const state = shell ? 'Shell' : HERD_STATUS_LABELS[displayed];
    const openable = pane.sessionId !== undefined && !props.pending;
    const closable = props.canClose && openable;
    // Open and close are siblings, never one button inside another.
    return (
        <View style={{ width: props.width, borderRadius: 12, overflow: 'hidden', backgroundColor: theme.colors.surfaceHigh, borderWidth: props.current ? 2 : needsYou ? 1.5 : StyleSheet.hairlineWidth, borderColor: props.current ? theme.colors.accent : needsYou ? theme.colors.status.error : theme.colors.divider, opacity: props.pending ? 0.5 : 1 }}>
            <Pressable
                onPress={() => props.onOpen(pane)}
                onLongPress={closable ? () => props.onLongPress(pane) : undefined}
                onPressOut={props.onPressOut}
                disabled={!openable}
                accessibilityRole="button"
                accessibilityState={{ selected: props.current, disabled: !openable }}
                accessibilityLabel={[props.current ? 'Current pane' : 'Open pane', labels.title, state, task].filter(Boolean).join(', ')}
                accessibilityHint={closable ? 'Long-press to rename or close' : undefined}
                style={({ pressed }) => ({ opacity: pressed ? 0.7 : 1 })}
            >
                <View style={{ height: props.previewHeight, backgroundColor: '#0c0c0b' }}>
                    {pane.sessionId !== undefined && <TerminalPreview sessionId={pane.sessionId} emptyState />}
                </View>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 48, paddingLeft: 10, paddingRight: closable ? 40 : 10, paddingVertical: 6 }}>
                    <AgentGlyph name={shell ? 'shell' : labels.agentKind ?? labels.agentName} size={16} />
                    <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
                        <Text numberOfLines={1} style={{ ...Typography.default('semiBold'), fontSize: 13, lineHeight: 16, color: theme.colors.text }}>{labels.title}</Text>
                        {task !== undefined && (
                            <Text numberOfLines={1} style={{ ...Typography.default(), fontSize: 11, lineHeight: 14, color: needsYou ? theme.colors.status.error : theme.colors.textSecondary }}>
                                {needsYou ? `${HERD_STATUS_LABELS[displayed]} · ${task}` : task}
                            </Text>
                        )}
                    </View>
                </View>
            </Pressable>
            {closable && (
                <Pressable
                    onPress={() => props.onClose(pane)}
                    hitSlop={4}
                    accessibilityRole="button"
                    accessibilityLabel={`Close ${labels.title}`}
                    style={({ pressed }) => ({ position: 'absolute', right: 0, bottom: 0, width: 40, height: 48, alignItems: 'center', justifyContent: 'center', opacity: pressed ? 0.5 : 1 })}
                >
                    <Ionicons name="close" size={18} color={theme.colors.textSecondary} />
                </Pressable>
            )}
            {!shell && (
                <View pointerEvents="none" style={{ position: 'absolute', top: 8, right: 8 }}>
                    <StatusDot color={tone.color} isPulsing={tone.pulsing} size={8} />
                </View>
            )}
        </View>
    );
});

function errorMessage(cause: unknown): string {
    return cause instanceof Error ? cause.message : String(cause);
}

export function PaneOverviewSheet(props: { visible: boolean; sessionId: string; onClose: () => void; onOpenSpaces: () => void }): React.JSX.Element {
    const { theme } = useUnistyles();
    const { workspaces, loaded } = useHerdrTree();
    const { pendingIds } = useLiveAgentIds();
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
    const [gridWidth, setGridWidth] = React.useState(0);
    // At a large text size Spaces keeps only its icon, so the workspace name is never cut to an ellipsis.
    const spacesWord = useWindowDimensions().fontScale < 1.3;

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
        // One sheet at a time: the switcher goes before its confirm comes up.
        close();
        Modal.alert(`Close ${labels.title}?`, 'Its running process stops. If it is the last pane of its tab, nothing closes.', [
            { text: 'Cancel', style: 'cancel' },
            {
                text: 'Close',
                style: 'destructive',
                icon: 'close-circle-outline',
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

    // A long-press swaps this sheet for its actions only once the finger lifts:
    // closing it under a held touch strands that touch, and no press after it fires.
    const held = React.useRef<(() => void) | undefined>(undefined);
    const released = React.useCallback(() => {
        const next = held.current;
        held.current = undefined;
        next?.();
    }, []);
    const paneActions = React.useCallback((pane: HerdrTreePane) => {
        held.current = () => {
            close();
            showPaneActions(pane, () => closePane(pane));
        };
    }, [close, closePane]);

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

    const splitDisabled = !canMutate || target === undefined;
    const splitButton = (direction: 'right' | 'down', label: string, icon: 'arrow-forward' | 'arrow-down') => (
        <Pressable
            onPress={() => setSplitDirection(direction)}
            disabled={splitDisabled}
            accessibilityRole="button"
            accessibilityLabel={`${direction === 'right' ? 'New pane to the right' : 'New pane below'}${canMutate ? '' : `, unavailable: ${VIEW_ONLY}`}`}
            accessibilityState={{ disabled: splitDisabled }}
            style={({ pressed }) => ({ minHeight: 44, alignSelf: 'stretch', flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, paddingHorizontal: 8, borderRadius: 10, backgroundColor: theme.colors.surfaceHigh, opacity: splitDisabled ? 0.45 : pressed ? 0.6 : 1 })}
        >
            <Ionicons name={icon} size={15} color={theme.colors.textSecondary} />
            <Text numberOfLines={1} style={{ ...Typography.default('semiBold'), flexShrink: 1, fontSize: 14, color: theme.colors.text }}>{label}</Text>
        </Pressable>
    );

    const header = (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4, paddingLeft: SIDE, paddingRight: SIDE - 8 }}>
            <Text numberOfLines={1} style={{ ...Typography.default('semiBold'), flex: 1, minWidth: 0, fontSize: 20, color: theme.colors.text }}>
                {located === undefined ? 'Panes' : workspaceName(located.workspace)}
            </Text>
            <Pressable
                onPress={() => { close(); props.onOpenSpaces(); }}
                accessibilityRole="button"
                accessibilityLabel="Spaces, every workspace"
                style={({ pressed }) => ({ minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: 8, opacity: pressed ? 0.6 : 1 })}
            >
                <Ionicons name="albums-outline" size={spacesWord ? 16 : 20} color={theme.colors.textLink} />
                {spacesWord && <Text style={{ ...Typography.default('semiBold'), fontSize: 15, color: theme.colors.textLink }}>Spaces</Text>}
            </Pressable>
            <Pressable onPress={close} accessibilityRole="button" accessibilityLabel="Done" style={({ pressed }) => ({ minHeight: 44, paddingHorizontal: 8, alignItems: 'center', justifyContent: 'center', opacity: pressed ? 0.6 : 1 })}>
                <Text style={{ ...Typography.default('semiBold'), fontSize: 15, color: theme.colors.textLink }}>Done</Text>
            </Pressable>
        </View>
    );

    // The tabs own a full-width lane: the actions above never share it.
    const tabLane = (
        <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            keyboardShouldPersistTaps="always"
            style={{ flexGrow: 0 }}
            contentContainerStyle={{ gap: 8, paddingHorizontal: SIDE, paddingTop: 8, paddingBottom: 12 }}
        >
            {tabs.map((entry, index) => {
                const active = entry.tabId === tab?.tabId;
                const here = entry.tabId === located?.tab.tabId;
                const status = displayedAgentStatus(entry.agentStatus, entry.panes.some((pane) => pane.sessionId !== undefined && pendingIds.has(pane.sessionId)));
                const tone = agentStatusColor(status, theme);
                const label = tabLabel(entry, index);
                const count = entry.panes.length === 1 ? '1 pane' : `${entry.panes.length} panes`;
                return (
                    <Pressable
                        key={entry.tabId}
                        onPress={() => setViewedTabId(entry.tabId)}
                        onLongPress={canMutate ? () => { held.current = () => { close(); showTabActions(entry.tabId, label); }; } : undefined}
                        onPressOut={released}
                        accessibilityRole="button"
                        accessibilityState={{ selected: active }}
                        accessibilityLabel={`${label}, ${count}${here ? ', this tab' : ''}`}
                        style={({ pressed }) => ({ minHeight: 36, flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 14, borderRadius: 18, backgroundColor: active ? theme.colors.surfaceSelected : theme.colors.surfaceHigh, opacity: pressed ? 0.6 : 1 })}
                    >
                        {(status === 'blocked' || status === 'working') && <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: tone.color }} />}
                        <Text numberOfLines={1} style={{ ...Typography.default(active ? 'semiBold' : 'regular'), maxWidth: 160, fontSize: 14, color: active ? theme.colors.text : theme.colors.textSecondary }}>{label}</Text>
                        <Text style={{ ...Typography.default(), fontSize: 12, color: theme.colors.textSecondary }}>{entry.panes.length}</Text>
                    </Pressable>
                );
            })}
        </ScrollView>
    );

    // Two cards across a phone, one on the narrowest; the preview is a little
    // taller than wide, like the phone's own terminal.
    const columns = gridWidth >= TWO_COLUMNS_FROM ? 2 : 1;
    const cardWidth = Math.floor((gridWidth - GAP * (columns - 1)) / columns);
    const previewHeight = columns === 2 ? Math.round(cardWidth * 1.1) : 140;
    const panes = tab?.panes ?? [];
    const grid = panes.length === 0
        ? <Text style={{ ...Typography.default(), color: theme.colors.textSecondary, textAlign: 'center', paddingVertical: 32 }}>{loaded ? 'No panes in this tab' : 'Loading panes…'}</Text>
        : (
            <View onLayout={(event) => setGridWidth(event.nativeEvent.layout.width)} style={{ flexDirection: 'row', flexWrap: 'wrap', gap: GAP }}>
                {gridWidth > 0 && panes.map((pane) => (
                    <PaneCard
                        key={pane.paneId}
                        pane={pane}
                        width={cardWidth}
                        previewHeight={previewHeight}
                        current={pane.paneId === target?.paneId}
                        pending={pending.has(pane.paneId)}
                        pendingRequest={pane.sessionId !== undefined && pendingIds.has(pane.sessionId)}
                        canClose={canMutate}
                        onOpen={openPane}
                        onClose={closePane}
                        onLongPress={paneActions}
                        onPressOut={released}
                    />
                ))}
                {gridWidth > 0 && (
                    // The add card sits among the panes it adds to, sized like them.
                    <View style={{ width: cardWidth, minHeight: columns === 2 ? previewHeight + 48 : undefined, borderRadius: 12, borderWidth: 1.5, borderStyle: 'dashed', borderColor: theme.colors.divider, padding: 10, gap: 8, justifyContent: 'center' }}>
                        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, paddingBottom: 2 }}>
                            <Ionicons name="add" size={18} color={theme.colors.textSecondary} />
                            <Text numberOfLines={1} style={{ ...Typography.default('semiBold'), flexShrink: 1, fontSize: 14, color: theme.colors.text }}>New pane</Text>
                        </View>
                        {splitButton('right', 'Right', 'arrow-forward')}
                        {splitButton('down', 'Below', 'arrow-down')}
                        {!canMutate && <Text style={{ ...Typography.default(), fontSize: 11, color: theme.colors.textSecondary }}>{VIEW_ONLY}</Text>}
                    </View>
                )}
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
            fill
            body={(
                <View style={{ flex: 1 }}>
                    {header}
                    {tabLane}
                    <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingHorizontal: SIDE, paddingBottom: 16 }}>
                        {grid}
                    </ScrollView>
                </View>
            )}
        />
        </ScopedTheme>
    );
}
