/**
 * The pane overview: one deliberate sheet over the session, opened from the
 * header's pane counter. Cards for every pane of the current tab from the
 * live tree, New pane and Close within that tab, Done back to the session
 * with its draft, scroll and Browser untouched. Refreshes the shared tree on
 * open and after each mutation; no poller of its own.
 */

import * as React from 'react';
import { AppState, Pressable, View } from 'react-native';
import { ScopedTheme, useUnistyles } from 'react-native-unistyles';
import { Text } from '@/components/StyledText';
import { OptionSheet, type ModelMode } from '@/components/OptionSheet';
import { Typography } from '@/constants/Typography';
import { Modal } from '@/modal';
import { sync } from '@/catalog/sync';
import { useHerdrTree } from '@/catalog/store';
import { resolveAgentCatalog } from '@/catalog';
import { useDeviceAuthority } from '@/pairing';
import { DOCK_AGENTS, visibleDockAgents } from '@/spawn';
import { humanError } from '@/utils/errors';
import { agentLabels, herdrTabForSession, tabLabel } from '../domain/agentPresentation';
import { rememberPaneSelection, useNavigateToSession } from '../application/useNavigateToSession';
import { PaneGridView } from './PaneGridView';
import type { HerdrTreePane } from '@muxr/contract';

const VIEW_ONLY = 'View-only devices cannot create or close panes';

export function PaneOverviewSheet(props: { visible: boolean; sessionId: string; machineId: string; onClose: () => void }): React.JSX.Element {
    const { theme } = useUnistyles();
    const { workspaces, loaded } = useHerdrTree();
    const { authority, loading: authorityLoading } = useDeviceAuthority();
    const canMutate = authority === 'control' && !authorityLoading;
    const navigate = useNavigateToSession();
    const located = herdrTabForSession(workspaces, props.sessionId);
    const tab = located?.tab;
    const tabIndex = located === undefined ? 0 : located.workspace.tabs.indexOf(located.tab);
    const panes = React.useMemo(() => tab?.panes ?? [], [tab]);
    const [mode, setMode] = React.useState<'panes' | 'agent'>('panes');
    const [pending, setPending] = React.useState<ReadonlySet<string>>(() => new Set());
    const [agents, setAgents] = React.useState<ModelMode[] | null>(null);
    const [foreground, setForeground] = React.useState(AppState.currentState === 'active');

    // Fresh tree on open; cards read while the sheet is open and the app is up.
    React.useEffect(() => {
        if (!props.visible) { setMode('panes'); return; }
        void sync.refreshHerdTree().catch(() => undefined);
    }, [props.visible]);
    React.useEffect(() => {
        const subscription = AppState.addEventListener('change', (next) => setForeground(next === 'active'));
        return () => subscription.remove();
    }, []);
    const refresh = React.useCallback(() => sync.refreshHerdTree().catch(() => undefined), []);

    const close = props.onClose;
    const openPane = React.useCallback((pane: HerdrTreePane) => {
        if (pane.sessionId === undefined || located === undefined) return;
        rememberPaneSelection({ machineId: props.machineId, workspaceId: located.workspace.workspaceId, tabId: located.tab.tabId }, pane.sessionId);
        close();
        if (pane.sessionId !== props.sessionId) navigate(pane.sessionId);
    }, [located, props.machineId, props.sessionId, navigate, close]);

    const closePane = React.useCallback((pane: HerdrTreePane) => {
        const sessionId = pane.sessionId;
        if (sessionId === undefined) return;
        const labels = agentLabels(pane);
        Modal.alert(`Close ${labels.taskTitle}?`, 'Its running process stops. If it is the last pane of its tab, nothing closes.', [
            { text: 'Cancel', style: 'cancel' },
            {
                text: 'Close',
                style: 'destructive',
                onPress: () => {
                    setPending((current) => new Set([...current, sessionId]));
                    sync.request('pane.close', { sessionId })
                        .then(async () => {
                            await refresh();
                            if (sessionId !== props.sessionId) return;
                            // The selected pane is gone: the next card, else the previous one.
                            const remaining = panes.filter((entry) => entry.sessionId !== undefined && entry.sessionId !== sessionId);
                            const index = panes.findIndex((entry) => entry.sessionId === sessionId);
                            const next = remaining[index] ?? remaining[remaining.length - 1];
                            close();
                            if (next?.sessionId !== undefined) navigate(next.sessionId);
                        })
                        .catch(async (cause: unknown) => {
                            const code = (cause as { code?: string }).code;
                            if (code === 'pane-close-would-widen') {
                                Modal.alert('Keep this pane', 'It is the last pane of its tab. Close the tab or the workspace from the spaces list instead.');
                            } else {
                                Modal.alert('Close failed', humanError(cause).message);
                            }
                            await refresh();
                        })
                        .finally(() => setPending((current) => { const next = new Set(current); next.delete(sessionId); return next; }));
                },
            },
        ]);
    }, [panes, props.sessionId, navigate, close, refresh]);

    // New pane: the same agent list the home dock offers, Shell first.
    const startNewPane = React.useCallback(() => {
        setMode('agent');
        if (agents !== null) return;
        void sync.request('herdr.agentKinds', {}).then((result) => {
            const launchable = resolveAgentCatalog(result).options.filter((option) => option.availability !== 'unavailable').map((option) => option.kind);
            setAgents(visibleDockAgents([...new Set(['shell', ...launchable])], true, 'shell'));
        }).catch(() => setAgents(DOCK_AGENTS.filter((option) => option.key === 'shell')));
    }, [agents]);
    const splitPane = React.useCallback((option: ModelMode) => {
        setMode('panes');
        const kind = option.agentKind;
        sync.request('pane.split', { sessionId: props.sessionId, direction: 'right', ...(kind === undefined ? {} : { kind }) })
            .then(async (result) => {
                await refresh();
                // An acknowledged session opens; a bare pane id stays on the
                // overview, where the refreshed tree shows what it became.
                if (result.sessionId === undefined) return;
                close();
                navigate(result.sessionId);
            })
            .catch(async (cause: unknown) => {
                Modal.alert('New pane failed', humanError(cause).message);
                await refresh();
            });
    }, [props.sessionId, navigate, close, refresh]);

    const label = tab === undefined ? 'Panes' : `Panes · ${tabLabel(tab, tabIndex)}`;
    const header = (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingBottom: 8 }}>
            <Text numberOfLines={1} style={{ ...Typography.default('semiBold'), flex: 1, minWidth: 0, fontSize: 15, color: theme.colors.text }}>{label}</Text>
            <Pressable
                onPress={startNewPane}
                disabled={!canMutate || tab === undefined}
                accessibilityRole="button"
                accessibilityLabel={`New pane${canMutate ? '' : `, unavailable: ${VIEW_ONLY}`}`}
                accessibilityState={{ disabled: !canMutate || tab === undefined }}
                style={({ pressed }) => ({ minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 12, borderRadius: 12, backgroundColor: theme.colors.surfaceHigh, opacity: !canMutate ? 0.45 : pressed ? 0.6 : 1 })}
            >
                {/* A named action is words: no leading glyph. */}
                <Text style={{ ...Typography.default('semiBold'), color: theme.colors.text }}>New pane</Text>
            </Pressable>
            <Pressable onPress={close} accessibilityRole="button" accessibilityLabel="Done" style={({ pressed }) => ({ minHeight: 44, paddingHorizontal: 14, alignItems: 'center', justifyContent: 'center', borderRadius: 12, opacity: pressed ? 0.6 : 1 })}>
                <Text style={{ ...Typography.default('semiBold'), color: theme.colors.textLink }}>Done</Text>
            </Pressable>
        </View>
    );

    // A sheet over the session paints from the dark surface whatever the app
    // is set to; the scope sits here, in this sheet's own render, so what it
    // mounts on its own state (the agent picker, pending cards) reads it too.
    if (mode === 'agent') {
        return (
            <ScopedTheme name="dark">
            <OptionSheet
                visible={props.visible}
                title="New pane"
                options={agents ?? []}
                emptyText="Checking which agents this computer can start…"
                onSelect={splitPane}
                onClose={() => setMode('panes')}
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
            virtualizedBody
            maxWidth={1000}
            body={(
                <PaneGridView
                    panes={panes}
                    selectedSessionId={props.sessionId}
                    pendingSessionIds={pending}
                    canClose={canMutate}
                    closeReason={canMutate ? undefined : VIEW_ONLY}
                    onOpen={openPane}
                    onClose={closePane}
                    header={header}
                    emptyText={loaded ? 'No panes in this tab' : 'Loading panes…'}
                    active={props.visible && foreground}
                    // A sheet over the session: its cards paint from the dark
                    // surface, whatever the app is set to.
                    surfaceTheme="dark"
                />
            )}
        />
        </ScopedTheme>
    );
}
