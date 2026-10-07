/**
 * Start an agent (or a squad of agents). Moshi-grade picker over herdr.
 *
 * Herdr runs every CLI, so the real choices are: which agent(s), and where.
 * One kind -> a single session. Two to four kinds -> squad mode: one tab per
 * kind in the same workspace, so pi and codex work side by side on one repo.
 * Where offers the desk's open workspaces first, then recent folders.
 */

import * as React from 'react';
import {
    ActivityIndicator,
    Keyboard,
    Platform,
    Pressable,
    ScrollView,
    View,
} from 'react-native';
import { KeyboardAwareScrollView, useKeyboardState } from 'react-native-keyboard-controller';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { sync } from '@/catalog/sync';
import { type HerdrTreeWorkspace } from '@trymuxr/contract';
import { Text } from '@/components/StyledText';
import { Switch } from '@/components/Switch';
import { AgentGlyph } from '@/components/AgentGlyph';
import { DirectoryPicker, type DirectoryPlace } from '@/spawn/ui';
import { wherePlaces } from '@/utils/directoryPicker';
import {
    getCachedConnectionSettings,
} from '@/connection';

import { resolveAgentCatalog, type AgentCatalogOption, type NewSessionAgentType } from '@/catalog';
import { useDeviceAuthority } from '@/pairing';
import {
    agentName,
    agentReadinessLabel,
    defaultAgentKind,
    useNewSessionDraft,
    catalogSourceLabel,
    startButtonLabel,
    startNewAgent,
    workspaceJoinPath,
    type CatalogSource,
} from '@/spawn';

const MAX_SQUAD = 4;
type AgentOption = AgentCatalogOption;

// Shell needs no agent install, so it leads the host catalog like Home's dock.
function withShell(options: readonly AgentOption[]): AgentOption[] {
    return [{ kind: 'shell', availability: 'installed' }, ...options.filter((option) => option.kind !== 'shell')];
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
        width: '100%',
        maxWidth: 800,
        alignSelf: 'center',
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
        minHeight: 136,
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
        lineHeight: 16,
        fontWeight: '600',
        textAlign: 'center',
    },
    agentAvailability: {
        color: theme.colors.textSecondary,
        fontSize: 10,
        fontWeight: '600',
        textAlign: 'center',
    },
    agentDetails: {
        color: theme.colors.textSecondary,
        fontSize: 12,
        lineHeight: 17,
        paddingHorizontal: 2,
        marginTop: 10,
    },
    squadHint: {
        color: theme.colors.textSecondary,
        fontSize: 12,
        paddingHorizontal: 2,
    },
    moreAgentsButton: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 6,
        minHeight: 44,
        marginTop: 8,
    },
    moreAgentsText: {
        color: theme.colors.textLink,
        fontSize: 13,
        fontWeight: '600',
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
        paddingHorizontal: 2,
    },
    worktreeTexts: {
        flex: 1,
        gap: 1,
    },
    worktreeTitle: {
        color: theme.colors.text,
        fontSize: 14,
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
        paddingHorizontal: 16,
        borderRadius: 10,
        backgroundColor: theme.colors.button.primary.background,
    },
    startButtonDisabled: {
        backgroundColor: theme.colors.surfaceHighest,
    },
    startButtonTextDisabled: {
        color: theme.colors.textSecondary,
        fontWeight: '600',
    },
    startButtonText: {
        color: theme.colors.button.primary.tint,
        fontSize: 16,
        fontWeight: '700',
    },
}));

// The browser keeps its own keyboard inset (useWebViewport); native needs the aware view.
const FormScrollView = Platform.OS === 'web' ? ScrollView : KeyboardAwareScrollView;

export default function NewAgentScreen() {
    const { theme } = useUnistyles();
    const insets = useSafeAreaInsets();
    const settings = getCachedConnectionSettings();
    const { authority, loading: authorityLoading } = useDeviceAuthority();
    const canControl = authority === 'control';

    const [catalog, setCatalog] = React.useState<readonly AgentOption[]>([]);
    const [catalogCheck, setCatalogCheck] = React.useState(0);
    const [catalogSource, setCatalogSource] = React.useState<CatalogSource>('loading');
    const [selected, setSelected] = React.useState<ReadonlySet<string>>(new Set());
    const [showUnavailableAgents, setShowUnavailableAgents] = React.useState(false);
    const [agentDetails, setAgentDetails] = React.useState<{ kind: string; text: string } | undefined>();
    const [cwd, setCwd] = React.useState(settings.lastSessionCwd || '~');
    const [worktree, setWorktree] = React.useState(false);
    const [workspaces, setWorkspaces] = React.useState<HerdrTreeWorkspace[]>([]);
    const [busy, setBusy] = React.useState(false);
    const [error, setError] = React.useState<string | undefined>(undefined);
    const [scrollHeight, setScrollHeight] = React.useState(0);
    const [isTypingPath, setIsTypingPath] = React.useState(false);
    const keyboardHeight = useKeyboardState((state) => state.height);

    const scrollRef = React.useRef<ScrollView>(null);
    const directoryRef = React.useRef<View>(null);
    const directoryY = React.useRef(0);
    const pickerY = React.useRef(0);
    const typingPath = React.useRef(false);
    const showPicker = React.useCallback(() => {
        const y = directoryY.current + pickerY.current;
        // Keep the directory input at the top so the list has room above the keyboard.
        // RN-web layout y goes stale after the viewport resizes, so use the DOM position there.
        if (Platform.OS === 'web') (directoryRef.current as unknown as HTMLElement | null)?.scrollIntoView({ block: 'start', behavior: 'smooth' });
        else scrollRef.current?.scrollTo({ y, animated: true });
    }, []);
    React.useEffect(() => {
        const shown = Keyboard.addListener('keyboardDidShow', () => {
            if (typingPath.current) requestAnimationFrame(showPicker);
        });
        return () => shown.remove();
    }, [showPicker]);
    // The browser has no keyboard events; its viewport shrinks instead, so pin again once it settles.
    React.useEffect(() => {
        if (Platform.OS === 'web' && isTypingPath) showPicker();
    }, [isTypingPath, scrollHeight, showPicker]);

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
            .request('herdr.agentKinds', { refresh: catalogCheck > 0 })
            .then((result) => {
                if (!live) return;
                const resolved = resolveAgentCatalog(result);
                const options = withShell(resolved.options);
                setCatalog(options);
                setAgentDetails(undefined);
                setCatalogSource(resolved.authoritative ? 'host' : 'unknown');
                const preferred = defaultAgentKind(options, useNewSessionDraft.getState().agentType);
                const installed = new Set(options.filter((option) => option.availability === 'installed').map((option) => option.kind));
                setSelected((previous) => {
                    const retained = new Set([...previous].filter((kind) => installed.has(kind)));
                    return retained.size > 0 ? retained : new Set(preferred ? [preferred] : []);
                });
            })
            .catch(() => { if (live) setCatalogSource('fallback'); });
        return () => {
            live = false;
        };
    }, [canControl, catalogCheck]);

    const toggleKind = React.useCallback((option: AgentOption) => {
        if (option.availability !== 'installed') return;
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
    const sourceLabel = catalogSourceLabel(catalogSource);
    const squad = kinds.length > 1;
    const unavailableCount = catalog.filter((option) => option.availability !== 'installed').length;
    const visibleCatalog = showUnavailableAgents
        ? catalog
        : catalog.filter((option) => option.availability === 'installed');
    const directory = cwd.trim();
    const ready = directory !== '' && kinds.length > 0;

    const start = React.useCallback(async () => {
        if (kinds.length === 0) {
            setError('Select an installed agent first.');
            return;
        }
        if (directory === '') {
            setError('Pick a directory first.');
            return;
        }
        if (kinds.length === 1) useNewSessionDraft.getState().setAgentType(kinds[0] as NewSessionAgentType);
        setBusy(true);
        setError(undefined);
        try {
            const result = await startNewAgent({
                directory,
                kinds,
                squad,
                worktree,
            });
            if (result.cancelled) {
                setError(undefined);
                return;
            }
            if (result.error !== undefined) setError(result.error);
        } finally {
            setBusy(false);
        }
    }, [directory, kinds, squad, worktree]);

    const styles = stylesheet;
    // Open workspaces first, then recent folders; the picker shows the first few.
    const places: DirectoryPlace[] = wherePlaces(workspaces.map(workspaceJoinPath), settings.recentSessionCwds ?? []);

    if (authorityLoading) {
        return (
            <View style={[styles.container, { alignItems: 'center', justifyContent: 'center' }]}>
                <ActivityIndicator color={theme.colors.textSecondary} />
            </View>
        );
    }

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

            <FormScrollView
                ref={(node: ScrollView | null) => { scrollRef.current = node; }}
                onLayout={({ nativeEvent }) => setScrollHeight(nativeEvent.layout.height)}
                // A reloading listing changes the content height and can clamp the scroll; pin the field again.
                onContentSizeChange={() => { if (typingPath.current && Platform.OS !== 'web') showPicker(); }}
                // Web gets no keyboard padding, so leave room below for the field to reach the top.
                contentContainerStyle={[styles.content, Platform.OS === 'web' && isTypingPath && { paddingBottom: scrollHeight }]}
                keyboardShouldPersistTaps="handled"
            >
                {/* --- Agent grid (multi-select -> squad) ---------------------- */}
                <View>
                    <View style={styles.sectionLabelRow}>
                        <Text style={styles.sectionLabel}>AGENT</Text>
                        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                            {sourceLabel !== undefined && (
                                <Text style={styles.squadBadgeText}>
                                    {sourceLabel}
                                </Text>
                            )}
                            {squad && (
                                <View style={styles.squadBadge}>
                                    <Ionicons name="grid" size={11} color={theme.colors.accent} />
                                    <Text style={styles.squadBadgeText}>SQUAD {kinds.length}</Text>
                                </View>
                            )}
                        </View>
                    </View>
                    {catalogSource === 'host' && !catalog.some((option) => option.availability === 'installed') && (
                        <Text style={styles.emptyHint}>No coding agent found on this computer. Open More agents for install instructions.</Text>
                    )}
                    <View style={styles.grid}>
                        {visibleCatalog.map((option) => {
                            const isSelected = selected.has(option.kind);
                            const available = option.availability === 'installed';
                            const availability = agentReadinessLabel(option);
                            const detail = available
                                ? option.signInHint ?? availability
                                : option.installHint ?? availability;
                            return (
                                <Pressable
                                    key={option.kind}
                                    onPress={() => {
                                        setAgentDetails({ kind: option.kind, text: detail });
                                        if (available) {
                                            toggleKind(option);
                                        }
                                    }}
                                    accessibilityRole="button"
                                    accessibilityLabel={`${agentName(option.kind)}, ${availability}. Tap for details${available ? ' and to select' : ''}`}
                                    accessibilityState={{ selected: isSelected }}
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
                                    {/* One size for every name; wraps at word boundaries, never shrunk per name. */}
                                    <Text style={styles.agentName}>
                                        {agentName(option.kind)}
                                    </Text>
                                    {availability !== undefined && (
                                        <Text style={styles.agentAvailability}>
                                            {available ? availability : 'Not installed'}
                                        </Text>
                                    )}
                                </Pressable>
                            );
                        })}
                    </View>
                    {agentDetails && (
                        <Text accessibilityRole="summary" style={styles.agentDetails}>
                            {agentName(agentDetails.kind)}: {agentDetails.text}
                        </Text>
                    )}
                    {unavailableCount > 0 && (
                        <Pressable
                            accessibilityRole="button"
                            onPress={() => setShowUnavailableAgents((visible) => !visible)}
                            style={({ pressed }) => [styles.moreAgentsButton, pressed && { opacity: 0.7 }]}
                        >
                            <Text style={styles.moreAgentsText}>
                                {showUnavailableAgents ? 'Show installed agents only' : `More agents (${unavailableCount}) — install`}
                            </Text>
                            <Ionicons
                                name={showUnavailableAgents ? 'chevron-up' : 'chevron-down'}
                                size={16}
                                color={theme.colors.textLink}
                            />
                        </Pressable>
                    )}
                    <Pressable accessibilityRole="button" onPress={() => { setCatalogSource('loading'); setCatalogCheck((value) => value + 1); }} style={styles.moreAgentsButton}>
                        <Text style={styles.moreAgentsText}>Check again</Text>
                    </Pressable>
                    <Text style={[styles.squadHint, { marginTop: 10 }]}>
                        {squad
                            ? `Squad: ${kinds.map(agentName).join(' · ')}. One tab each, same workspace.`
                            : 'Pick up to 4 agents to run them together as a squad.'}
                    </Text>
                </View>

                {/* --- Where --------------------------------------------------- */}
                <View onLayout={({ nativeEvent }) => { directoryY.current = nativeEvent.layout.y; }}>
                    <View style={styles.sectionLabelRow}>
                        <Text style={styles.sectionLabel}>WHERE</Text>
                    </View>
                    <View ref={directoryRef} onLayout={({ nativeEvent }) => { pickerY.current = nativeEvent.layout.y; }}>
                        <DirectoryPicker
                            value={cwd}
                            onChange={setCwd}
                            places={places}
                            room={isTypingPath && scrollHeight > 0 ? scrollHeight - (Platform.OS === 'web' ? 0 : keyboardHeight) : undefined}
                            onFocus={() => {
                                typingPath.current = true;
                                setIsTypingPath(true);
                                showPicker();
                            }}
                            onBlur={() => {
                                typingPath.current = false;
                                setIsTypingPath(false);
                            }}
                        />
                    </View>
                </View>

                {/* --- Worktree: a quiet secondary option ------------------------ */}
                <Pressable onPress={() => setWorktree((value) => !value)} accessibilityRole="switch" accessibilityState={{ checked: worktree }}>
                    <View style={styles.worktreeRow}>
                        <View style={styles.worktreeTexts}>
                            <Text style={styles.worktreeTitle}>Use a separate worktree</Text>
                            <Text style={styles.worktreeSubtitle}>A fresh checkout on its own branch, so this folder stays untouched.</Text>
                        </View>
                        <Switch
                            value={worktree}
                            onValueChange={setWorktree}
                        />
                    </View>
                </Pressable>

                {error !== undefined && <Text style={styles.errorText}>{error}</Text>}


            </FormScrollView>
            <View style={{ padding: 16, paddingBottom: Math.max(16, insets.bottom) }}>
                <Pressable
                    onPress={start}
                    disabled={busy || !ready}
                    accessibilityRole="button"
                    accessibilityState={{ disabled: busy || !ready }}
                    style={[styles.startButton, !ready && styles.startButtonDisabled]}
                >
                    {busy ? (
                        <ActivityIndicator color={theme.colors.button.primary.tint} />
                    ) : (
                        <Text numberOfLines={1} style={[styles.startButtonText, !ready && styles.startButtonTextDisabled]}>
                            {startButtonLabel(kinds, directory)}
                        </Text>
                    )}
                </Pressable>
            </View>
        </View>
    );
}
