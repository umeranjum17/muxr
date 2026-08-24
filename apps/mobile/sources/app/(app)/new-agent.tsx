/**
 * Start an agent (or a squad of agents). Moshi-grade picker over herdr.
 *
 * Herdr runs every CLI, so the real choices are: which agent(s), and where.
 * One kind -> a single session. Two to four kinds -> squad mode: one tab per
 * kind in the same workspace, so pi and codex work side by side on one repo.
 * "Join a running workspace" reuses whatever the desk already has open.
 */

import * as React from 'react';
import {
    ActivityIndicator,
    Platform,
    Pressable,
    ScrollView,
    View,
} from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { sync } from '@/sync/sync';
import { MISSING_CWD_ERROR_PREFIX, type HerdrTreeWorkspace } from '@muxr/contract';
import { Modal } from '@/modal';
import { Text } from '@/components/StyledText';
import { StatusDot } from '@/components/StatusDot';
import { Switch } from '@/components/Switch';
import { AgentGlyph } from '@/components/AgentGlyph';
import { DirectoryPicker } from '@/components/DirectoryPicker';
import { agentStatusColor } from '@/utils/sessionUtils';
import {
    getCachedConnectionSettings,
    rememberSessionCwd,
    saveConnectionSettings,
} from '@/state/connectionSettings';

import { FALLBACK_AGENT_KINDS, resolveAgentCatalog, type AgentCatalogOption } from '@/sync/agentKinds';
import { getCachedHostedGrant } from '@/state/hostedE2ee';

const MAX_SQUAD = 4;
const MAX_RECENT_CHIPS = 6;
type AgentOption = AgentCatalogOption;
const MAX_WORKSPACE_ROWS = 6;

function basename(path: string): string {
    return path.split('/').filter(Boolean).pop() ?? path;
}

const stylesheet = StyleSheet.create((theme) => ({
    container: {
        flex: 1,
        backgroundColor: theme.colors.groupped.background,
    },
    header: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        paddingHorizontal: 16,
        paddingVertical: 12,
    },
    headerTitle: {
        color: theme.colors.text,
        fontSize: 17,
        fontWeight: '700',
    },
    content: {
        padding: 16,
        paddingBottom: 32,
        gap: 22,
    },
    sectionLabelRow: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        paddingHorizontal: 2,
        marginBottom: 10,
    },
    sectionLabel: {
        color: theme.colors.textSecondary,
        fontSize: 11,
        fontWeight: '700',
        letterSpacing: 2,
    },
    squadBadge: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 4,
        backgroundColor: theme.colors.accentSubtle,
        borderRadius: 6,
        paddingHorizontal: 8,
        paddingVertical: 3,
    },
    squadBadgeText: {
        color: theme.colors.accent,
        fontSize: 11,
        fontWeight: '700',
        letterSpacing: 0.5,
    },
    grid: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        gap: 10,
    },
    agentCard: {
        flexGrow: 1,
        flexBasis: '30%',
        alignItems: 'center',
        gap: 8,
        paddingVertical: 14,
        paddingHorizontal: 8,
        borderRadius: 14,
        backgroundColor: theme.colors.surfaceHigh,
        borderWidth: 1,
        borderColor: theme.colors.divider,
    },
    agentName: {
        color: theme.colors.text,
        fontSize: 13,
        fontWeight: '600',
    },
    agentAvailability: {
        color: theme.colors.textSecondary,
        fontSize: 10,
        fontWeight: '600',
    },
    squadHint: {
        color: theme.colors.textSecondary,
        fontSize: 12,
        paddingHorizontal: 2,
    },
    workspaceRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 10,
        paddingHorizontal: 12,
        paddingVertical: 11,
        borderRadius: 10,
        backgroundColor: theme.colors.surfaceHigh,
        borderWidth: 1,
        borderColor: theme.colors.divider,
    },
    workspaceLabel: {
        color: theme.colors.text,
        fontSize: 14,
        fontWeight: '600',
        flexShrink: 1,
    },
    workspaceMeta: {
        color: theme.colors.textSecondary,
        fontSize: 12,
    },
    workspaceList: {
        gap: 8,
    },
    emptyHint: {
        color: theme.colors.textSecondary,
        fontSize: 13,
        paddingHorizontal: 2,
    },
    worktreeRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 12,
        paddingHorizontal: 12,
        paddingVertical: 12,
        borderRadius: 12,
        backgroundColor: theme.colors.surfaceHigh,
        borderWidth: 1,
        borderColor: theme.colors.divider,
    },
    worktreeIcon: {
        width: 34,
        height: 34,
        borderRadius: 10,
        backgroundColor: 'rgba(52, 199, 89, 0.14)',
        alignItems: 'center',
        justifyContent: 'center',
    },
    worktreeTexts: {
        flex: 1,
        gap: 1,
    },
    worktreeTitle: {
        color: theme.colors.text,
        fontSize: 14,
        fontWeight: '600',
    },
    worktreeSubtitle: {
        color: theme.colors.textSecondary,
        fontSize: 12,
    },
    errorText: {
        color: theme.colors.deleteAction,
        fontSize: 13,
    },
    startButton: {
        alignItems: 'center',
        justifyContent: 'center',
        height: 48,
        borderRadius: 10,
        backgroundColor: theme.colors.button.primary.background,
    },
    startButtonDisabled: {
        opacity: 0.4,
    },
    startButtonText: {
        color: theme.colors.button.primary.tint,
        fontSize: 16,
        fontWeight: '700',
    },
}));

export default function NewAgentScreen() {
    const { theme } = useUnistyles();
    const insets = useSafeAreaInsets();
    const settings = getCachedConnectionSettings();
    const canControl = Platform.OS !== 'web' || getCachedHostedGrant(settings.machineId)?.authority === 'control';

    const [catalog, setCatalog] = React.useState<readonly AgentOption[]>(
        FALLBACK_AGENT_KINDS.map((kind) => ({ kind, availability: 'unknown' })),
    );
    const [catalogSource, setCatalogSource] = React.useState<'loading' | 'host' | 'unknown' | 'fallback'>('loading');
    const [selected, setSelected] = React.useState<ReadonlySet<string>>(new Set());
    const [cwd, setCwd] = React.useState(settings.lastSessionCwd ?? '');
    const [worktree, setWorktree] = React.useState(false);
    const [workspaces, setWorkspaces] = React.useState<HerdrTreeWorkspace[]>([]);
    const [busy, setBusy] = React.useState(false);
    const [error, setError] = React.useState<string | undefined>(undefined);

    React.useEffect(() => {
        if (!canControl) return undefined;
        let live = true;
        void sync
            .request('herdr.tree', {})
            .then((tree) => {
                if (live) setWorkspaces(tree.workspaces ?? []);
            })
            .catch(() => {});
        void sync
            .request('herdr.agentKinds', {})
            .then((result) => {
                if (!live) return;
                const resolved = resolveAgentCatalog(result);
                setCatalog(resolved.options);
                setCatalogSource(resolved.authoritative ? 'host' : 'unknown');
                if (resolved.authoritative) {
                    const installed = new Set(resolved.options.filter((option) => option.availability === 'installed').map((option) => option.kind));
                    // An empty host probe is usually a broken service environment,
                    // not proof that the user's saved squad should be erased.
                    if (installed.size > 0) setSelected((previous) => new Set([...previous].filter((kind) => installed.has(kind))));
                }
            })
            .catch(() => { if (live) setCatalogSource('fallback'); });
        return () => {
            live = false;
        };
    }, [canControl]);

    const toggleKind = React.useCallback((option: AgentOption) => {
        if (option.availability === 'unavailable') return;
        const kind = option.kind;
        setSelected((previous) => {
            const next = new Set(previous);
            if (next.has(kind)) {
                if (next.size === 1) return previous; // never strand the picker empty
                next.delete(kind);
            } else {
                if (next.size >= MAX_SQUAD) return previous;
                next.add(kind);
            }
            return next;
        });
    }, []);

    const kinds = [...selected];
    const squad = kinds.length > 1;
    const directory = cwd.trim();

    const start = React.useCallback(async () => {
        if (kinds.length === 0) {
            setError('Select an installed agent first.');
            return;
        }
        if (directory === '') {
            setError('Pick a directory first.');
            return;
        }
        setBusy(true);
        setError(undefined);
        try {
            let createCwd = false;
            for (;;) {
                try {
                    const snapshot = await sync.request('session.start', {
                        cwd: directory,
                        ...(createCwd ? { createCwd: true } : {}),
                        ...(squad ? { kinds } : { kind: kinds[0] }),
                        ...(worktree ? { worktree: {} } : {}),
                    });
                    await saveConnectionSettings(rememberSessionCwd(getCachedConnectionSettings(), directory));
                    await sync.refreshSessions();
                    router.replace(`/session/${snapshot.info.id}`);
                    return;
                } catch (caught: unknown) {
                    const message = caught instanceof Error ? caught.message : String(caught);
                    // Missing cwd is not an error, it's a question: create it?
                    if (!createCwd && message.includes(MISSING_CWD_ERROR_PREFIX)) {
                        setBusy(false);
                        createCwd = await Modal.confirm(
                            'Create directory?',
                            `${directory} does not exist. Create it?`,
                            { confirmText: 'Create', cancelText: 'Cancel' },
                        );
                        if (createCwd) {
                            setBusy(true);
                            continue;
                        }
                        setError(undefined);
                        return;
                    }
                    setError(message);
                    setBusy(false);
                    return;
                }
            }
        } finally {
            setBusy(false);
        }
    }, [directory, kinds, squad, worktree]);

    const styles = stylesheet;
    const recent = (settings.recentSessionCwds ?? []).slice(0, MAX_RECENT_CHIPS);

    if (!canControl) {
        return (
            <View style={[styles.container, { paddingTop: insets.top, paddingBottom: insets.bottom }]}>
                <View style={styles.header}>
                    <Text style={styles.headerTitle}>New agent</Text>
                    <Pressable onPress={() => router.back()} hitSlop={12} accessibilityRole="button" accessibilityLabel="Close">
                        <Ionicons name="close" size={24} color={theme.colors.text} />
                    </Pressable>
                </View>
                <View style={styles.content}>
                    <Text style={styles.emptyHint}>This browser has view-only access. Run “muxr pair --browser” on the computer to pair a control browser that can start agents, create worktrees, and type into terminals.</Text>
                </View>
            </View>
        );
    }

    return (
        <View style={[styles.container, { paddingTop: insets.top }]}>
            <View style={styles.header}>
                <Text style={styles.headerTitle}>New agent</Text>
                <Pressable onPress={() => router.back()} hitSlop={12} accessibilityRole="button" accessibilityLabel="Close">
                    <Ionicons name="close" size={24} color={theme.colors.text} />
                </Pressable>
            </View>

            <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
                {/* --- Agent grid (multi-select -> squad) ---------------------- */}
                <View>
                    <View style={styles.sectionLabelRow}>
                        <Text style={styles.sectionLabel}>AGENT</Text>
                        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                            <Text style={styles.squadBadgeText}>
                                {catalogSource === 'host' ? 'FROM HERDR' : catalogSource === 'loading' ? 'CHECKING HOST' : catalogSource === 'unknown' ? 'HOST AVAILABILITY UNKNOWN' : 'OFFLINE FALLBACK'}
                            </Text>
                            {squad && (
                                <View style={styles.squadBadge}>
                                    <Ionicons name="grid" size={11} color={theme.colors.accent} />
                                    <Text style={styles.squadBadgeText}>SQUAD {kinds.length}</Text>
                                </View>
                            )}
                        </View>
                    </View>
                    <View style={styles.grid}>
                        {catalog.map((option) => {
                            const isSelected = selected.has(option.kind);
                            const available = option.availability !== 'unavailable';
                            return (
                                <Pressable
                                    key={option.kind}
                                    onPress={() => toggleKind(option)}
                                    disabled={!available}
                                    accessibilityRole="button"
                                    accessibilityLabel={`${option.kind}, ${option.availability === 'installed' ? 'installed' : option.availability === 'unavailable' ? 'not installed' : catalogSource === 'loading' ? 'checking installation' : 'installation status unknown'}`}
                                    accessibilityState={{ disabled: !available, selected: isSelected }}
                                    style={[
                                        styles.agentCard,
                                        !available && { opacity: 0.45 },
                                        isSelected && {
                                            borderColor: theme.colors.accent,
                                            borderWidth: 1,
                                            backgroundColor: theme.colors.accentFaint,
                                        },
                                    ]}
                                >
                                    <AgentGlyph name={option.kind} size={40} selected={isSelected} dim={!available} />
                                    <Text numberOfLines={1} style={styles.agentName}>
                                        {option.kind}
                                    </Text>
                                    {(option.availability !== 'unknown' || catalogSource === 'loading') && (
                                        <Text numberOfLines={1} style={styles.agentAvailability}>
                                            {option.availability === 'installed' ? 'Installed' : option.availability === 'unavailable' ? 'Not installed' : 'Checking host'}
                                        </Text>
                                    )}
                                </Pressable>
                            );
                        })}
                    </View>
                    <Text style={[styles.squadHint, { marginTop: 10 }]}>
                        {squad
                            ? `Squad: ${kinds.join(' · ')}. One tab each, same workspace.`
                            : 'Pick up to 4 agents to run them together as a squad.'}
                    </Text>
                </View>

                {/* --- Directory ---------------------------------------------- */}
                <View>
                    <View style={styles.sectionLabelRow}>
                        <Text style={styles.sectionLabel}>DIRECTORY</Text>
                    </View>
                    <DirectoryPicker value={cwd} onChange={setCwd} recent={recent} />
                </View>

                {/* --- Join a running workspace -------------------------------- */}
                {workspaces.length > 0 && (
                    <View>
                        <View style={styles.sectionLabelRow}>
                            <Text style={styles.sectionLabel}>JOIN A RUNNING WORKSPACE</Text>
                        </View>
                        <View style={styles.workspaceList}>
                            {workspaces.slice(0, MAX_WORKSPACE_ROWS).map((workspace) => {
                                const paneCount = workspace.tabs.reduce((total, tab) => total + tab.panes.length, 0);
                                const label = workspace.label ?? workspace.workspaceId;
                                const target =
                                    workspace.worktree?.path ??
                                    (workspace.label !== undefined && workspace.label.startsWith('/')
                                        ? workspace.label
                                        : undefined);
                                const pulsing =
                                    workspace.agentStatus === 'working' || workspace.agentStatus === 'blocked';
                                return (
                                    <Pressable
                                        key={workspace.workspaceId}
                                        onPress={() => {
                                            if (target !== undefined) setCwd(target);
                                        }}
                                        style={({ pressed }) => [
                                            styles.workspaceRow,
                                            pressed && { opacity: 0.8 },
                                        ]}
                                    >
                                        <StatusDot
                                            color={agentStatusColor(workspace.agentStatus, theme).color}
                                            isPulsing={pulsing}
                                            size={7}
                                        />
                                        <Text numberOfLines={1} style={styles.workspaceLabel}>
                                            {basename(label)}
                                        </Text>
                                        <Text style={styles.workspaceMeta}>
                                            {paneCount} {paneCount === 1 ? 'pane' : 'panes'}
                                        </Text>
                                        {target !== undefined ? (
                                            <Ionicons name="chevron-forward" size={16} color={theme.colors.textSecondary} />
                                        ) : (
                                            <Ionicons name="eye-outline" size={16} color={theme.colors.textSecondary} />
                                        )}
                                    </Pressable>
                                );
                            })}
                        </View>
                    </View>
                )}

                {/* --- Worktree toggle ------------------------------------------ */}
                <Pressable onPress={() => setWorktree((value) => !value)}>
                    <View style={styles.worktreeRow}>
                        <View style={styles.worktreeIcon}>
                            <Ionicons name="git-branch" size={18} color={theme.colors.status.connected} />
                        </View>
                        <View style={styles.worktreeTexts}>
                            <Text style={styles.worktreeTitle}>Run in a fresh worktree</Text>
                            <Text style={styles.worktreeSubtitle}>Isolated checkout for parallel work</Text>
                        </View>
                        <Switch
                            value={worktree}
                            onValueChange={setWorktree}
                        />
                    </View>
                </Pressable>

                {error !== undefined && <Text style={styles.errorText}>{error}</Text>}

                <Pressable
                    onPress={start}
                    disabled={busy || directory === '' || kinds.length === 0}
                    style={[styles.startButton, (busy || directory === '' || kinds.length === 0) && styles.startButtonDisabled]}
                >
                    {busy ? (
                        <ActivityIndicator color={theme.colors.button.primary.tint} />
                    ) : (
                        <Text style={styles.startButtonText}>
                            {kinds.length === 0 ? 'Select an installed agent' : squad ? `Start squad (${kinds.length})` : `Start ${kinds[0]}`}
                        </Text>
                    )}
                </Pressable>
            </ScrollView>
        </View>
    );
}
