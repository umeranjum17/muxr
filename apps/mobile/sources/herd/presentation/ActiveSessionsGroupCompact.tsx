import React from 'react';
import { View, Pressable, Platform } from 'react-native';
import { Text } from '@/components/StyledText';
import { SessionRowData } from '@/sync/storage';
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import { sessionStateColors, unreadStateColors, vibingMessages } from '../application/sessionUtils';
import { formatPathRelativeToHome } from '../domain/sessionIdentity';
import { Avatar } from '@/components/Avatar';
import { Typography } from '@/constants/Typography';
import { StatusDot } from '@/components/StatusDot';
import { isSettledSession, SessionMetaLine } from './SessionRowParts';
import { useAllMachines } from '@/sync/storage';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { t } from '@/text';
import { useNavigateToSession } from '../application/useNavigateToSession';
import { SessionActionsAnchor, SessionActionsPopover } from './SessionActionsPopover';
import { isWorktreePath, getRepoPath } from '@/spawn';
import { useNewSessionDraft } from '@/spawn';
import { useRouter } from 'expo-router';
import { SessionShortcutHintBadge } from '@/components/ShortcutHints';
import { buildActiveSessionDisplayGroups } from '../domain/sessionDisplayOrder';
import { ProviderIcon } from '@/components/ProviderIcon';
import { useDeviceAuthority } from '@/pairing';

interface ActiveSessionsGroupProps {
    sessions: SessionRowData[];
    selectedSessionId?: string;
}

// Section header: avatar | path + branch + tree icon + line changes | + button
const SectionHeader = React.memo(({ session, displayPath }: { session: SessionRowData; displayPath: string }) => {
    const styles = stylesheet;
    const { theme } = useUnistyles();
    const router = useRouter();
    const draft = useNewSessionDraft();
    const { authority, loading: authorityLoading } = useDeviceAuthority();

    const sessionPath = session.path || '';
    const isWorktree = isWorktreePath(sessionPath);
    const repoPath = isWorktree ? getRepoPath(sessionPath) : sessionPath;
    const repoDisplayPath = isWorktree
        ? formatPathRelativeToHome(repoPath, session.homeDir ?? undefined)
        : displayPath;
    const repoFolderName = repoPath.split(/[/\\]/).filter(Boolean).pop() || repoDisplayPath;

    // herdr-native header: the workspace label is the primary line when herdr
    // named the workspace; the plain cwd stays the fallback.
    // Use the GROUP's label, not the first session's workspace label: a repo
    // and its worktrees fold into one group, and naming it after whichever
    // session sorted first made the header lie about what it contained.
    const primaryLabel = displayPath !== '' ? displayPath : repoFolderName;

    const handleAdd = React.useCallback(() => {
        const machineId = session.machineId;
        if (machineId) {
            draft.setMachineId(machineId);
        }
        const pathToSet = formatPathRelativeToHome(repoPath, session.homeDir ?? undefined);
        draft.setPath(pathToSet);
        draft.setSessionType(isWorktree ? 'worktree' : 'simple');
        draft.setWorktreeKey(isWorktree ? sessionPath : null);
        router.navigate('/new-agent');
    }, [session.machineId, session.homeDir, repoPath, isWorktree, sessionPath, draft, router]);

    const [isHovered, setIsHovered] = React.useState(false);

    return (
        <View
            style={styles.sectionHeader}
            // @ts-ignore - Web only events
            onMouseEnter={() => setIsHovered(true)}
            // @ts-ignore - Web only events
            onMouseLeave={() => setIsHovered(false)}
        >
            {/* Avatar — vertically centered */}
            <View style={styles.sectionHeaderAvatar}>
                <Avatar id={session.avatarId} size={24} flavor={null} />
            </View>

            {/* Group header = the group label only. A branch line here lies
                whenever one group holds more than one checkout (repo + worktrees),
                which the subgroup rows already name. */}
            <View style={styles.sectionHeaderContent}>
                <Text style={styles.sectionHeaderPath} numberOfLines={1}>
                    {primaryLabel}
                </Text>
            </View>

            {/* + button — vertically centered, large hit area; desktop: hover-only */}
            <Pressable
                onPress={handleAdd}
                disabled={authorityLoading || authority !== 'control'}
                hitSlop={{ top: 15, bottom: 15, left: 15, right: 15 }}
                style={[styles.addButton, {
                    opacity: authorityLoading || authority !== 'control'
                        ? 0.35
                        : Platform.OS !== 'web' || isHovered ? 1 : 0,
                }]}
            >
                <Ionicons name="add-outline" size={14} color={theme.colors.textSecondary} />
            </Pressable>
        </View>
    );
});

// Full-width separator between machine groups: ——— 🖥 name ———
const MachineSeparator = React.memo(({ machineName, machineId }: { machineName: string; machineId: string }) => {
    const styles = stylesheet;
    const { theme } = useUnistyles();
    const router = useRouter();

    const handlePress = React.useCallback(() => {
        router.navigate(`/machine/${machineId}` as any);
    }, [router, machineId]);

    return (
        <Pressable onPress={handlePress} style={styles.machineSeparator} hitSlop={{ top: 8, bottom: 8 }}>
            <View style={styles.machineSeparatorLine} />
            <Ionicons name="desktop-outline" size={11} color={theme.colors.textSecondary} style={{ marginHorizontal: 6 }} />
            <Text style={styles.machineSeparatorText} numberOfLines={1}>
                {machineName}
            </Text>
            <View style={styles.machineSeparatorLine} />
        </Pressable>
    );
});

export function ActiveSessionsGroupCompact({ sessions, selectedSessionId }: ActiveSessionsGroupProps) {
    const styles = stylesheet;
    const { theme } = useUnistyles();
    const machines = useAllMachines();

    const machineGroups = React.useMemo(() => buildActiveSessionDisplayGroups(
        sessions,
        machines,
        t('status.unknown'),
    ), [machines, sessions]);
    const hasMultipleMachines = machineGroups.length > 1;

    return (
        <View style={styles.container}>
            {machineGroups.map(machineGroup => {
                const sortedProjects = Array.from(machineGroup.projects.entries()).sort(
                    ([, a], [, b]) => a.displayPath.localeCompare(b.displayPath)
                );

                return (
                    <React.Fragment key={machineGroup.machineId}>
                        {hasMultipleMachines && (
                            <MachineSeparator
                                machineName={machineGroup.machineName}
                                machineId={machineGroup.machineId}
                            />
                        )}
                        {sortedProjects.map(([projectPath, projectGroup]) => {
                            const firstSession = projectGroup.sessions[0];
                            if (!firstSession) return null;

                            return (
                                <View key={projectPath}>
                                    <SectionHeader
                                        session={firstSession}
                                        displayPath={projectGroup.displayPath}
                                    />
                                    <View style={styles.projectCard}>
                                        {projectGroup.subgroups.map((subgroup) => (
                                            <View key={subgroup.key}>
                                                {subgroup.label !== null && (
                                                    <View style={styles.subgroupHeader}>
                                                        <Ionicons
                                                            name={subgroup.isWorktree ? 'git-branch-outline' : 'albums-outline'}
                                                            size={12}
                                                            color={theme.colors.textSecondary}
                                                        />
                                                        <Text style={styles.subgroupLabel} numberOfLines={1}>
                                                            {subgroup.label}
                                                        </Text>
                                                    </View>
                                                )}
                                                {subgroup.sessions.map((session, index) => (
                                                    <CompactSessionRow
                                                        key={session.id}
                                                        session={session}
                                                        selected={selectedSessionId === session.id}
                                                        showBorder={index < subgroup.sessions.length - 1}
                                                    />
                                                ))}
                                            </View>
                                        ))}
                                    </View>
                                </View>
                            );
                        })}
                    </React.Fragment>
                );
            })}
        </View>
    );
}

// Compact session row with status dot indicator
const CompactSessionRow = React.memo(({ session, selected, showBorder }: { session: SessionRowData; selected?: boolean; showBorder?: boolean }) => {
    const styles = stylesheet;
    const { theme } = useUnistyles();
    const baseStatus = sessionStateColors(session.state, theme);
    // Override to solid accent when session has unread results
    const status = session.hasUnread
        ? unreadStateColors(theme, baseStatus)
        : baseStatus;
    const navigateToSession = useNavigateToSession();
    const [actionsAnchor, setActionsAnchor] = React.useState<SessionActionsAnchor | null>(null);

    const handlePress = React.useCallback(() => {
        navigateToSession(session.id);
    }, [navigateToSession, session.id]);

    const handleContextMenu = React.useCallback((event: any) => {
        event.preventDefault?.();
        event.stopPropagation?.();
        setActionsAnchor({
            type: 'point',
            x: event.nativeEvent.clientX ?? event.nativeEvent.pageX ?? 0,
            y: event.nativeEvent.clientY ?? event.nativeEvent.pageY ?? 0,
        });
    }, []);
    const menuProps = Platform.OS === 'web' ? {
        onContextMenu: handleContextMenu,
    } as any : {};

    const renderLeadingIndicator = () => {
        let indicator: React.ReactNode = null;

        if (session.hasUnread) {
            indicator = <StatusDot color={status.dotColor} isPulsing={false} />;
        } else if (session.state === 'waiting' && session.hasDraft) {
            indicator = (
                <Ionicons
                    name="create-outline"
                    size={14}
                    color={theme.colors.textSecondary}
                />
            );
        } else if (session.state === 'permission_required' || session.state === 'thinking') {
            indicator = <StatusDot color={status.dotColor} isPulsing={status.isPulsing} />;
        } else if (session.state === 'waiting') {
            indicator = <StatusDot color={theme.colors.textSecondary} isPulsing={false} />;
        }

        return (
            <View style={styles.leadingIndicatorSlot}>
                {indicator}
            </View>
        );
    };

    const settled = isSettledSession(session);

    const itemContent = (
        <Pressable
            style={({ pressed }) => [
                styles.sessionRow,
                { opacity: pressed ? 0.55 : settled ? 0.75 : 1 },
                showBorder && styles.sessionRowWithBorder,
                selected && styles.sessionRowSelected
            ]}
            onPress={handlePress}
            accessibilityRole="button"
            accessibilityState={{ selected: !!selected }}
            accessibilityLabel={`${session.name}, ${session.hasUnread ? t('status.unread') : status.isConnected ? t('status.online') : t('status.offline')}`}
            {...menuProps}
        >
            <View style={styles.sessionContent}>
                <View style={styles.sessionTitleRow}>
                    {renderLeadingIndicator()}

                    <Text
                        style={[
                            styles.sessionTitle,
                            status.isConnected ? styles.sessionTitleConnected : styles.sessionTitleDisconnected
                        ]}
                        numberOfLines={2}
                    >
                        {session.name}
                    </Text>
                    <SessionShortcutHintBadge
                        sessionId={session.id}
                        style={styles.sessionShortcutBadge}
                    />
                </View>
                {session.identityLine && (
                    <View style={styles.sessionIdentityRow}>
                        <ProviderIcon kind={session.providerKind} size={11} monochrome />
                        <SessionMetaLine
                            style={{ flex: 1 }}
                            segments={[
                                { text: session.identityLine },
                                { text: session.modelName },
                                { text: session.activitySummary },
                            ]}
                        />
                    </View>
                )}
                {session.spawnedBy !== null && (
                    <Text style={styles.sessionIdentity} numberOfLines={1}>
                        spawned
                    </Text>
                )}
            </View>
        </Pressable>
    );

    return (
        <>
            {itemContent}
            <SessionActionsPopover
                anchor={actionsAnchor}
                onClose={() => setActionsAnchor(null)}
                sessionId={session.id}
                visible={!!actionsAnchor}
            />
        </>
    );
});

const stylesheet = StyleSheet.create((theme) => ({
    container: {
        backgroundColor: Platform.select({ web: theme.colors.groupped.background, default: 'transparent' }),
        paddingTop: 8,
    },
    // Section header styles
    sectionHeader: {
        paddingTop: 12,
        paddingBottom: Platform.select({ ios: 6, default: 8 }),
        paddingHorizontal: Platform.select({ ios: 32, default: 24 }),
        flexDirection: 'row',
        alignItems: 'center',
    },
    sectionHeaderAvatar: {
        marginRight: 8,
    },
    sectionHeaderContent: {
        flex: 1,
        justifyContent: 'center',
        minWidth: 0,
    },
    sectionHeaderPath: {
        ...Typography.default('regular'),
        color: theme.colors.groupped.sectionTitle,
        fontSize: Platform.select({ ios: 13, default: 14 }),
        lineHeight: Platform.select({ ios: 18, default: 20 }),
        letterSpacing: Platform.select({ ios: -0.08, default: 0.1 }),
        fontWeight: Platform.select({ ios: 'normal', default: '500' }),
        flexShrink: 1,
    },
    addButton: {
        marginLeft: 4,
        padding: 8,
    },
    // Machine separator styles
    machineSeparator: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: Platform.select({ ios: 32, default: 24 }),
        paddingTop: 8,
        paddingBottom: 0,
    },
    machineSeparatorLine: {
        flex: 1,
        height: StyleSheet.hairlineWidth,
        backgroundColor: theme.colors.divider,
    },
    machineSeparatorText: {
        fontSize: 11,
        color: theme.colors.textSecondary,
        ...Typography.default('regular'),
        marginRight: 4,
    },
    // Project card styles
    subgroupHeader: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
        paddingHorizontal: 14,
        paddingTop: 8,
        paddingBottom: 4,
    },
    subgroupLabel: {
        color: theme.colors.textSecondary,
        fontSize: 12,
        flex: 1,
    },
    projectCard: {
        backgroundColor: theme.colors.surface,
        marginBottom: 8,
        marginHorizontal: Platform.select({ ios: 16, default: 12 }),
        borderRadius: Platform.select({ web: 16, default: 18 }),
        borderWidth: Platform.select({ web: 0, default: StyleSheet.hairlineWidth }),
        borderColor: theme.colors.divider,
        overflow: 'hidden',
        shadowColor: Platform.select({ web: theme.colors.shadow.color, default: 'transparent' }),
        shadowOffset: { width: 0, height: 0.33 },
        shadowOpacity: Platform.select({ web: theme.colors.shadow.opacity, default: 0 }),
        shadowRadius: 0,
        elevation: Platform.select({ web: 1, default: 0 }),
    },
    // Session row styles
    sessionRow: {
        height: 56,
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: 16,
        backgroundColor: 'transparent',
        // Long-press must open multi-select, not highlight the row's text.
        ...Platform.select({ web: { userSelect: 'none' } as any, default: {} }),
    },
    sessionRowWithBorder: {
        borderBottomWidth: StyleSheet.hairlineWidth,
        borderBottomColor: theme.colors.divider,
    },
    sessionRowSelected: {
        backgroundColor: theme.colors.surfaceSelected,
    },
    sessionContent: {
        flex: 1,
        justifyContent: 'center',
    },
    sessionTitleRow: {
        flexDirection: 'row',
        alignItems: 'center',
    },
    sessionTitle: {
        fontSize: 15,
        flex: 1,
        ...Typography.default('regular'),
    },
    sessionShortcutBadge: {
        flexShrink: 0,
        marginLeft: 8,
    },
    sessionTitleConnected: {
        color: theme.colors.text,
    },
    sessionTitleDisconnected: {
        color: theme.colors.textSecondary,
    },
    sessionIdentity: {
        fontSize: 11,
        color: theme.colors.textSecondary,
        ...Typography.default('regular'),
        flexShrink: 1,
    },
    sessionIdentityRow: {
        marginLeft: 24,
        marginTop: 2,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 4,
    },
    leadingIndicatorSlot: {
        alignItems: 'center',
        justifyContent: 'center',
        width: 16,
        height: 16,
        marginRight: 8,
    },
}));
