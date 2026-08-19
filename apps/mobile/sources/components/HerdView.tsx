/**
 * Herd: herdr's live herd on the phone Herd tab — mobile-first, one surface.
 *
 * Two layers, top to bottom: the live terminal strip IS the agents view
 * (LiveTerminalsRow cards carry status + cwd + kind, self-hides when nothing
 * is live), then workspace cards as the groupings (agent rows only — bare
 * shells are noise on this screen).
 */

import * as React from 'react';
import {
    ActivityIndicator,
    Pressable,
    SectionList,
    View,
    NativeScrollEvent,
    NativeSyntheticEvent,
    Platform,
} from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Text } from '@/components/StyledText';
import { useFocusEffect, useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { sync } from '@/sync/sync';
import { Modal } from '@/modal';
import { storage, useHerdrTree, useSocketStatus } from '@/sync/storage';
import { useHostedPairing, usePairQrScanner } from '@/hooks/usePairing';
import * as Clipboard from 'expo-clipboard';
import { loadAppConfig } from '@/sync/appConfig';
import { getCachedConnectionSettings } from '@/state/connectionSettings';
import { listPairedGrants } from '@/state/hostedE2ee';
import { openExternalUrl } from '@/utils/openExternalUrl';
import { setupEmptyState } from '@/commercialization';
import type { HerdrTreePane, HerdrTreeWorkspace } from '@muxr/contract';
import { agentStatusColor } from '@/utils/sessionUtils';
import { StatusDot } from './StatusDot';
import { Avatar } from './Avatar';
import { RoundButton } from './RoundButton';
import { ActionButton } from './ActionButton';
import { LiveTerminalsRow } from './LiveTerminalsRow';
import { buildSpaceRows, hasAgent, lifecycleTree, middleTruncate, workspaceName, type HerdRow } from '@/utils/herdTree';
import { Typography } from '@/constants/Typography';
import { layout } from './layout';

const stylesheet = StyleSheet.create((theme) => ({
    container: {
        flex: 1,
        backgroundColor: theme.colors.groupped.background,
    },
    contentContainer: {
        flex: 1,
        maxWidth: layout.maxWidth,
        width: '100%',
        alignSelf: 'center',
    },
    sectionHeader: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: 16,
        paddingTop: 18,
        paddingBottom: 6,
    },
    sectionTitle: {
        fontSize: 13,
        fontWeight: '600',
        color: theme.colors.groupped.sectionTitle,
        letterSpacing: 0.2,
        textTransform: 'uppercase',
        ...Typography.default('semiBold'),
    },
    card: {
        backgroundColor: theme.colors.surfaceHigh,
        borderRadius: 14,
        marginHorizontal: 12,
        marginTop: 10,
        overflow: 'hidden',
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: theme.colors.divider,
    },
    cardHeader: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        paddingHorizontal: 16,
        paddingVertical: 10,
        minHeight: 48,
    },
    cardHeaderExpanded: {
        borderBottomWidth: StyleSheet.hairlineWidth,
        borderBottomColor: theme.colors.divider,
    },
    cardHeaderPressed: {
        backgroundColor: theme.colors.surfacePressedOverlay,
    },
    chevron: {
        width: 16,
        alignItems: 'center',
    },
    cardTitle: {
        flexShrink: 1,
        fontSize: 15,
        fontWeight: '600',
        color: theme.colors.text,
        ...Typography.default('semiBold'),
    },
    branchPill: {
        backgroundColor: theme.colors.surface,
        borderRadius: 5,
        paddingHorizontal: 6,
        paddingVertical: 2,
        maxWidth: 140,
    },
    branchPillText: {
        fontSize: 10,
        color: theme.colors.textSecondary,
        ...Typography.default(),
    },
    agentCount: {
        marginLeft: 'auto',
        fontSize: 12,
        fontWeight: '600',
        color: theme.colors.textSecondary,
        ...Typography.default('semiBold'),
    },
    agentRow: {
        paddingHorizontal: 16,
    },
    agentPressable: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 10,
        minHeight: 56,
        paddingVertical: 8,
    },
    agentPressablePressed: {
        backgroundColor: theme.colors.surfacePressedOverlay,
    },
    agentText: {
        flex: 1,
        minWidth: 0,
    },
    agentName: {
        fontSize: 14,
        fontWeight: '600',
        color: theme.colors.text,
        ...Typography.default('semiBold'),
    },
    agentSubtitle: {
        fontSize: 12,
        color: theme.colors.textSecondary,
        marginTop: 2,
        ...Typography.default(),
    },
    separator: {
        height: StyleSheet.hairlineWidth,
        backgroundColor: theme.colors.divider,
        marginLeft: 58,
    },
    empty: {
        flex: 1,
        alignItems: 'center',
        justifyContent: 'center',
        gap: 8,
        padding: 32,
    },
    banner: {
        flexDirection: 'row',
        alignItems: 'flex-start',
        gap: 8,
        marginHorizontal: 16,
        marginTop: 8,
        padding: 12,
        borderRadius: 10,
        backgroundColor: theme.colors.surfaceHigh,
    },
    bannerText: {
        flex: 1,
        fontSize: 13,
        lineHeight: 18,
        ...Typography.default(),
    },
    emptyText: {
        color: theme.colors.textSecondary,
        fontSize: 14,
        textAlign: 'center',
        ...Typography.default(),
    },
    emptyAction: {
        marginTop: 12,
    },
    setupTitle: {
        color: theme.colors.text,
        fontSize: 22,
        lineHeight: 28,
        textAlign: 'center',
        ...Typography.default('semiBold'),
    },
    setupCard: {
        width: '100%',
        maxWidth: 360,
        marginTop: 20,
        backgroundColor: theme.colors.surfaceHigh,
        borderWidth: 1,
        borderColor: theme.colors.divider,
        borderRadius: 16,
        padding: 18,
    },
    setupStep: {
        flexDirection: 'row',
        alignItems: 'flex-start',
        gap: 12,
        marginBottom: 16,
    },
    stepBadge: {
        width: 26,
        height: 26,
        borderRadius: 13,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: theme.colors.accentSubtle,
    },
    stepNumber: {
        ...Typography.mono('semiBold'),
        fontSize: 13,
        color: theme.colors.text,
        includeFontPadding: false,
    },
    stepBody: {
        flex: 1,
    },
    stepText: {
        color: theme.colors.textSecondary,
        fontSize: 14,
        lineHeight: 20,
        ...Typography.default(),
    },
    stepTextInline: {
        paddingTop: 3,
    },
    commandRow: {
        flexDirection: 'row',
        alignItems: 'center',
        marginTop: 8,
        borderRadius: 10,
        backgroundColor: theme.colors.surface,
        borderWidth: 1,
        borderColor: theme.colors.divider,
        paddingLeft: 12,
        paddingRight: 6,
        paddingVertical: 6,
    },
    setupCommand: {
        flex: 1,
        fontSize: 14,
        color: theme.colors.text,
        ...Typography.mono(),
    },
    copyButton: {
        width: 36,
        height: 36,
        borderRadius: 8,
        alignItems: 'center',
        justifyContent: 'center',
    },
    error: {
        fontSize: 12,
        paddingHorizontal: 16,
        paddingTop: 8,
        ...Typography.default(),
    },
}));

/** One row: generated avatar, name, short cwd · kind, live status dot. Shells too. */
const AgentRow = React.memo(({ pane, first, onClose }: { pane: HerdrTreePane; first?: boolean; onClose: () => void }) => {
    const { theme } = useUnistyles();
    const router = useRouter();
    const styles = stylesheet;
    const dot = agentStatusColor(pane.agentStatus, theme);
    const kind = pane.agentKind ?? 'shell';
    const cwd = pane.cwd ?? '';
    const name = pane.label ?? pane.agentName ?? pane.terminalTitle ?? kind;
    const sessionId = pane.sessionId;
    const subtitle = cwd === '' ? kind : `${middleTruncate(cwd)} · ${kind}`;
    return (
        <View style={styles.agentRow}>
            {first !== true && <View style={styles.separator} />}
            <Pressable
                onPress={sessionId === undefined ? undefined : () => router.push(`/session/${encodeURIComponent(sessionId)}`)}
                onLongPress={onClose}
                disabled={sessionId === undefined}
                style={({ pressed }) => [
                    styles.agentPressable,
                    pressed ? styles.agentPressablePressed : undefined,
                ]}
                android_ripple={{ color: theme.colors.surfaceRipple, foreground: true }}
                accessibilityRole="button"
                accessibilityLabel={`Open ${name}`}
            >
                <Avatar id={pane.paneId} size={32} flavor={null} />
                <View style={styles.agentText}>
                    <Text numberOfLines={1} style={styles.agentName}>{name}</Text>
                    <Text numberOfLines={1} style={styles.agentSubtitle}>{subtitle}</Text>
                </View>
                <StatusDot color={dot.color} isPulsing={dot.pulsing} size={7} />
            </Pressable>
        </View>
    );
});

/** Workspace group card: header (chevron, live dot, name, branch pill, agent badge) + agent rows. */
const WorkspaceCard = React.memo(({
    workspace,
    expanded,
    agentCount,
    panes,
    onToggle,
    onClose,
    onClosePane,
}: {
    workspace: HerdrTreeWorkspace;
    expanded: boolean;
    agentCount: number;
    panes: HerdrTreePane[];
    onToggle: () => void;
    onClose: () => void;
    onClosePane: (pane: HerdrTreePane) => void;
}) => {
    const { theme } = useUnistyles();
    const styles = stylesheet;
    const dot = agentStatusColor(workspace.agentStatus, theme);
    const branch = workspace.worktree?.branch;
    // Every workspace has panes to expand into, shells included.
    const tappable = true;
    return (
        <View style={styles.card}>
            <Pressable
                onPress={tappable ? onToggle : undefined}
                onLongPress={onClose}
                style={({ pressed }) => [
                    styles.cardHeader,
                    expanded ? styles.cardHeaderExpanded : undefined,
                    tappable && pressed ? styles.cardHeaderPressed : undefined,
                ]}
                android_ripple={{ color: theme.colors.surfaceRipple, foreground: true }}
                accessibilityRole="button"
                accessibilityLabel={`${workspaceName(workspace)} workspace, ${agentCount} agent${agentCount === 1 ? '' : 's'}`}
            >
                {tappable ? (
                    <View style={styles.chevron}>
                        <Ionicons
                            name={expanded ? 'chevron-down' : 'chevron-forward'}
                            size={16}
                            color={theme.colors.groupped.chevron}
                        />
                    </View>
                ) : (
                    <View style={styles.chevron} />
                )}
                <StatusDot color={dot.color} isPulsing={dot.pulsing} size={8} />
                <Text numberOfLines={1} style={styles.cardTitle}>
                    {workspaceName(workspace)}
                </Text>
                {branch === undefined ? null : (
                    <View style={styles.branchPill}>
                        <Text numberOfLines={1} style={styles.branchPillText}>{branch}</Text>
                    </View>
                )}
                {agentCount > 0 && (
                    <Text style={styles.agentCount}>
                        {agentCount} agent{agentCount === 1 ? '' : 's'}
                    </Text>
                )}
            </Pressable>
            {expanded &&
                panes.map((pane, index) => (
                    <AgentRow key={pane.paneId} pane={pane} first={index === 0} onClose={() => onClosePane(pane)} />
                ))}
        </View>
    );
});

export const HerdView = React.memo(({
    topContentInset = 0,
    bottomContentInset = 128,
    header,
    onScroll,
    searchQuery = '',
}: {
    topContentInset?: number;
    bottomContentInset?: number;
    header?: React.ReactNode;
    onScroll?: (event: NativeSyntheticEvent<NativeScrollEvent>) => void;
    searchQuery?: string;
}) => {
    const { theme } = useUnistyles();
    const styles = stylesheet;
    const router = useRouter();
    const safeArea = useSafeAreaInsets();
    const { workspaces: sourceWorkspaces, loaded } = useHerdrTree();
    const { status: socketStatus } = useSocketStatus();
    const processPairLink = useHostedPairing();
    const scanPairQr = usePairQrScanner((url) => void processPairLink(url));
    const workspaces = React.useMemo(
        () => lifecycleTree(sourceWorkspaces, socketStatus === 'connected'),
        [socketStatus, sourceWorkspaces],
    );
    const [attempted, setAttempted] = React.useState(false);
    const [error, setError] = React.useState<string | null>(null);
    // undefined = host has not told us (older host build); false = herdr is down.
    const [herdrConnected, setHerdrConnected] = React.useState<boolean | undefined>(undefined);
    // "Has this device ever paired" can only come from the persisted grants:
    // machineId falls back to the build default on a fresh install, so it can
    // never answer this. Async, so undefined = still loading.
    const [hasPairedGrant, setHasPairedGrant] = React.useState<boolean | undefined>(undefined);
    React.useEffect(() => {
        let cancelled = false;
        void listPairedGrants().then((grants) => {
            if (!cancelled) setHasPairedGrant(grants.length > 0);
        });
        return () => { cancelled = true; };
    }, []);
    const [expanded, setExpanded] = React.useState<ReadonlySet<string>>(new Set());

    const refresh = React.useCallback(async () => {
        try {
            const { workspaces, herdrConnected } = await sync.refreshHerdTree();
            setHerdrConnected(herdrConnected);
            // Default: workspaces that host agents start expanded; shell-only stays closed.
            setExpanded((previous) => (previous.size > 0
                ? previous
                : new Set(workspaces.filter(hasAgent).map((ws) => ws.workspaceId))));
            setError(null);
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
        } finally {
            setAttempted(true);
        }
    }, []);

    // Refresh on focus, then keep the screen honest with a 5s poll while it's
    // on display — a pane closed at the desk used to linger here until reload.
    useFocusEffect(
        React.useCallback(() => {
            void refresh();
            const interval = setInterval(() => void refresh(), 5_000);
            return () => clearInterval(interval);
        }, [refresh]),
    );

    // And again, debounced, when the sessions store changes (a session may have
    // picked up a pane id since the tree was last fetched).
    const debounceRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
    React.useEffect(() => {
        const unsubscribe = storage.subscribe((state, previous) => {
            if (state.sessions === previous.sessions) return;
            if (debounceRef.current !== null) clearTimeout(debounceRef.current);
            debounceRef.current = setTimeout(() => void refresh(), 1_000);
        });
        return () => {
            unsubscribe();
            if (debounceRef.current !== null) clearTimeout(debounceRef.current);
        };
    }, [refresh]);

    const toggleWorkspace = React.useCallback((workspaceId: string) => {
        setExpanded((previous) => {
            const next = new Set(previous);
            if (next.has(workspaceId)) {
                next.delete(workspaceId);
            } else {
                next.add(workspaceId);
            }
            return next;
        });
    }, []);

    // Long-press a card: close the whole workspace in herdr (tabs, panes,
    // processes).
    const confirmCloseWorkspace = React.useCallback((workspace: HerdrTreeWorkspace) => {
        const name = workspaceName(workspace);
        Modal.alert('Close space?', `Closes "${name}" in herdr — its tabs, panes, and their processes are gone.`, [
            { text: 'Cancel', style: 'cancel' },
            {
                text: 'Close',
                style: 'destructive',
                onPress: () => {
                    storage.getState().applyHerdrTree(
                        storage.getState().herdrWorkspaces.filter((entry) => entry.workspaceId !== workspace.workspaceId),
                    );
                    sync.request('workspace.close', { workspaceId: workspace.workspaceId })
                        .then(refresh)
                        .catch((err) => {
                            Modal.alert('Close failed', err instanceof Error ? err.message : String(err));
                            void refresh();
                        });
                },
            },
        ]);
    }, [refresh]);

    // Long-press a row: close that one pane (shell or agent) in herdr.
    const confirmClosePane = React.useCallback((pane: HerdrTreePane) => {
        const sessionId = pane.sessionId;
        if (sessionId === undefined) return;
        const name = pane.agentName ?? pane.terminalTitle ?? pane.agentKind ?? 'shell';
        Modal.alert('Close pane?', `Closes "${name}" in herdr — its process is gone.`, [
            { text: 'Cancel', style: 'cancel' },
            {
                text: 'Close',
                style: 'destructive',
                onPress: () => {
                    // Drop the row now. The round-trip plus the 5s poll used to
                    // leave a closed pane sitting there looking alive, and a
                    // swallowed error left it there for good with no explanation.
                    storage.getState().applyHerdrTree(storage.getState().herdrWorkspaces.map((workspace) => ({
                        ...workspace,
                        tabs: workspace.tabs.map((tab) => ({
                            ...tab,
                            panes: tab.panes.filter((entry) => entry.sessionId !== sessionId),
                        })),
                    })));
                    sync.request('pane.close', { sessionId })
                        .then(refresh)
                        .catch((err) => {
                            Modal.alert('Close failed', err instanceof Error ? err.message : String(err));
                            void refresh();
                        });
                },
            },
        ]);
    }, [refresh]);

    const sections = React.useMemo(() => {
        return [{ key: 'spaces', title: 'spaces', data: buildSpaceRows(workspaces, expanded, searchQuery) }];
    }, [workspaces, expanded, searchQuery]);

    const keyExtractor = React.useCallback((item: HerdRow) => `ws-${item.workspace.workspaceId}`, []);

    const renderSectionHeader = React.useCallback(({ section }: { section: { title: string } }) => {
        return (
            <View style={styles.sectionHeader}>
                <Text style={styles.sectionTitle}>{section.title}</Text>
            </View>
        );
    }, [styles]);

    const renderItem = React.useCallback(({ item }: { item: HerdRow; index: number }) => {
        return (
            <WorkspaceCard
                workspace={item.workspace}
                expanded={item.expanded}
                agentCount={item.agentCount}
                panes={item.panes}
                onToggle={() => toggleWorkspace(item.workspace.workspaceId)}
                onClose={() => confirmCloseWorkspace(item.workspace)}
                onClosePane={confirmClosePane}
            />
        );
    }, [styles, toggleWorkspace, confirmCloseWorkspace, confirmClosePane]);

    // "No agents anywhere" hides the whole list in favour of the friendly empty
    // state; the live strip already hides itself.
    // Shell-only spaces still list (and close) their panes, so "empty" means
    // herdr has no workspaces at all, not "no agents".
    const agentsEmpty = workspaces.length === 0;
    const setup = setupEmptyState(loadAppConfig().publicBaseUrl);
    const connection = getCachedConnectionSettings();
    // machines.list rejects while the host is down, and machineId falls back
    // to the build default on a fresh install — only the persisted pairing
    // grants can tell "never paired" from "paired but the machine is off".
    const neverPaired = connection.mode === 'hosted' && hasPairedGrant === false;

    if (!loaded && !attempted) {
        return (
            <View style={[styles.empty, { paddingBottom: safeArea.bottom }]}>
                <ActivityIndicator color={theme.colors.textSecondary} />
            </View>
        );
    }

    if (agentsEmpty) {
        if (connection.mode === 'hosted' && hasPairedGrant === undefined) {
            // Grant storage has not answered yet: showing either the onboarding
            // card or the error branch now would be a guess.
            return (
                <View style={[styles.empty, { paddingBottom: safeArea.bottom }]}>
                    <ActivityIndicator color={theme.colors.textSecondary} />
                </View>
            );
        }
        if (neverPaired) {
            return (
                <View style={[styles.empty, { paddingBottom: safeArea.bottom }]}>
                    <Ionicons name="desktop-outline" size={40} color={theme.colors.textSecondary} />
                    <Text style={styles.setupTitle}>{setup.title}</Text>
                    <View style={styles.setupCard}>
                        <View style={styles.setupStep}>
                            <View style={styles.stepBadge}><Text style={styles.stepNumber}>1</Text></View>
                            <View style={styles.stepBody}>
                                <Text style={styles.stepText}>Run this on your computer</Text>
                                <View style={styles.commandRow}>
                                    <Text style={styles.setupCommand}>{setup.command}</Text>
                                    <Pressable
                                        accessibilityRole="button"
                                        accessibilityLabel="Copy setup command"
                                        hitSlop={10}
                                        style={styles.copyButton}
                                        onPress={() => void Clipboard.setStringAsync(setup.command)}
                                    >
                                        <Ionicons name="copy-outline" size={17} color={theme.colors.textSecondary} />
                                    </Pressable>
                                </View>
                            </View>
                        </View>
                        <View style={styles.setupStep}>
                            <View style={styles.stepBadge}><Text style={styles.stepNumber}>2</Text></View>
                            <Text style={[styles.stepText, styles.stepTextInline]}>
                                Choose this network, Tailscale, a tunnel, or SSH
                            </Text>
                        </View>
                        <View style={[styles.setupStep, { marginBottom: 0 }]}>
                            <View style={styles.stepBadge}><Text style={styles.stepNumber}>3</Text></View>
                            <Text style={[styles.stepText, styles.stepTextInline]}>Scan the QR code with this phone</Text>
                        </View>
                    </View>
                    <View style={styles.emptyAction}>
                        {Platform.OS === 'web' ? (
                            <ActionButton title="Paste browser pairing string" icon="clipboard-outline" onPress={() => router.push('/pair')} />
                        ) : (
                            <>
                                <ActionButton title="Scan pairing QR" icon="qr-code-outline" onPress={() => void scanPairQr()} />
                                {setup.setupUrl ? (
                                    <ActionButton title="Open setup guide" variant="quiet" icon="open-outline" onPress={() => void openExternalUrl(setup.setupUrl!)} />
                                ) : null}
                            </>
                        )}
                    </View>
                </View>
            );
        }
        return (
            // Plugin surfaces live in the header. Someone with no agents is usually
            // a new user, who most needs to see that their plugins landed.
            <View style={{ flex: 1, paddingTop: topContentInset }}>
                {header}
            {herdrConnected === false ? (
                <View style={styles.banner}>
                    <Ionicons name="warning-outline" size={16} color={theme.colors.box.warning.text} />
                    <Text style={[styles.bannerText, { color: theme.colors.box.warning.text }]}>
                        This computer is online, but its agent runtime (herdr) is not answering — sessions may be stale. Restart herdr on the machine to refresh them.
                    </Text>
                </View>
            ) : null}
            <View style={[styles.empty, { paddingBottom: safeArea.bottom }]}>
                <Ionicons name="albums-outline" size={40} color={theme.colors.textSecondary} />
                <Text style={styles.emptyText}>
                    {error !== null
                        ? error
                        : searchQuery.trim() !== ''
                            ? 'No matches'
                            : 'No agents yet — start one below.'}
                </Text>
                {error !== null && (
                    <View style={styles.emptyAction}>
                        <RoundButton
                            title="Set up connection"
                            size="normal"
                            onPress={() => router.push('/settings/connection' as any)}
                        />
                    </View>
                )}
            </View>
            </View>
        );
    }

    return (
        <View style={styles.container}>
            {error === null ? null : (
                <Text style={[styles.error, { color: theme.colors.status.error }]}>{error}</Text>
            )}
            {herdrConnected === false ? (
                <View style={styles.banner}>
                    <Ionicons name="warning-outline" size={16} color={theme.colors.box.warning.text} />
                    <Text style={[styles.bannerText, { color: theme.colors.box.warning.text }]}>
                        This computer is online, but its agent runtime (herdr) is not answering — sessions below may be stale. Restart herdr on the machine to refresh them.
                    </Text>
                </View>
            ) : null}
            <View style={styles.contentContainer}>
                <SectionList
                    sections={sections}
                    keyExtractor={keyExtractor}
                    renderItem={renderItem}
                    renderSectionHeader={renderSectionHeader}
                    stickySectionHeadersEnabled={false}
                    ListHeaderComponent={<>{header}<LiveTerminalsRow /></>}
                    onScroll={onScroll}
                    scrollEventThrottle={16}
                    contentContainerStyle={{
                        paddingTop: topContentInset,
                        paddingBottom: safeArea.bottom + bottomContentInset,
                    }}
                />
            </View>
        </View>
    );
});
