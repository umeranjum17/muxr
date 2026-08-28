import React, { useState, useMemo, useCallback, useRef } from 'react';
import { View, Text, ScrollView, RefreshControl, Platform, Pressable, TextInput } from 'react-native';
import { useFocusEffect, useLocalSearchParams, useRouter, Stack } from 'expo-router';
import { Item } from '@/components/Item';
import { ItemGroup } from '@/components/ItemGroup';
import { ItemList } from '@/components/ItemList';
import { Typography } from '@/constants/Typography';
import { useSessions, useAllMachines, useMachine, useLocalSetting } from '@/sync/storage';
import { Ionicons } from '@expo/vector-icons';
import type { Session } from '@/sync/storageTypes';
import { Modal } from '@/modal';
import { formatPathRelativeToHome, getSessionName, getSessionSubtitle } from '@/herd';
import { isMachineOnline } from '@/pairing';
import { sync } from '@/sync/sync';
import { useUnistyles, StyleSheet } from 'react-native-unistyles';
import { t } from '@/text';
import { useNavigateToSession } from '@/herd';
import { machineSpawnNewSession } from '@/sync/ops';
import { resolveAbsolutePath } from '@/utils/pathUtils';
import { MultiTextInput, type MultiTextInputHandle } from '@/components/MultiTextInput';
import { getCachedHostedGrant } from '@/state/hostedE2ee';
import { getCachedConnectionSettings, pairingTransport } from '@/state/connectionSettings';
import { loadCollaborationIntent } from '@/collaboration';

function formatNames(names: string[]): string {
    if (names.length < 2) return names[0] ?? '';
    return `${names.slice(0, -1).join(', ')}${names.length > 2 ? ',' : ''} and ${names[names.length - 1]}`;
}

const styles = StyleSheet.create((theme) => ({
    pathInputContainer: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        paddingHorizontal: 16,
        paddingVertical: 16,
    },
    pathInput: {
        flex: 1,
        borderRadius: 8,
        backgroundColor: Platform.select({
            web: theme.colors.input?.background ?? theme.colors.groupped.background,
            default: theme.colors.glass.backgroundSubtle,
        }),
        borderWidth: 1,
        borderColor: theme.colors.divider,
        minHeight: 44,
        position: 'relative',
        paddingHorizontal: 12,
        paddingVertical: Platform.select({ web: 10, ios: 8, default: 10 }) as any,
    },
    inlineSendButton: {
        position: 'absolute',
        right: 8,
        bottom: 10,
        width: 32,
        height: 32,
        borderRadius: 16,
        justifyContent: 'center',
        alignItems: 'center',
    },
    inlineSendActive: {
        backgroundColor: theme.colors.button.primary.background,
    },
    inlineSendInactive: {
        // Use a darker neutral in light theme to avoid blending into input
        backgroundColor: Platform.select({
            ios: theme.colors.permissionButton?.inactive?.background ?? theme.colors.surfaceHigh,
            android: theme.colors.permissionButton?.inactive?.background ?? theme.colors.surfaceHigh,
            default: theme.colors.permissionButton?.inactive?.background ?? theme.colors.surfaceHigh,
        }) as any,
    },
}));

export default function MachineDetailScreen() {
    const { theme } = useUnistyles();
    const { id: machineId } = useLocalSearchParams<{ id: string }>();
    const router = useRouter();
    const sessions = useSessions();
    const machine = useMachine(machineId!);
    const devModeEnabled = useLocalSetting('devModeEnabled');
    const navigateToSession = useNavigateToSession();
    const [isRefreshing, setIsRefreshing] = useState(false);
    const [customPath, setCustomPath] = useState('');
    const [isSpawning, setIsSpawning] = useState(false);
    const inputRef = useRef<MultiTextInputHandle>(null);
    const [showAllPaths, setShowAllPaths] = useState(false);
    const [collaborators, setCollaborators] = useState<string[]>([]);
    useFocusEffect(useCallback(() => {
        let cancelled = false;
        void loadCollaborationIntent().then((intent) => {
            if (cancelled || !machineId || !intent.selectedMachineIds.includes(machineId)) {
                if (!cancelled) setCollaborators([]);
                return;
            }
            const selected = new Set(intent.selectedMachineIds.filter((id) => id !== machineId));
            setCollaborators(intent.machines.filter((entry) => selected.has(entry.machineId)).map((entry) => entry.name));
        });
        return () => { cancelled = true; };
    }, [machineId]));
    // Variant D only

    const machineSessions = useMemo(() => {
        if (!sessions || !machineId) return [];

        return sessions.filter(item => {
            if (typeof item === 'string') return false;
            const session = item as Session;
            return session.metadata?.machineId === machineId;
        }) as Session[];
    }, [sessions, machineId]);

    const previousSessions = useMemo(() => {
        return [...machineSessions]
            .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
            .slice(0, 5);
    }, [machineSessions]);

    const recentPaths = useMemo(() => {
        const paths = new Set<string>();
        machineSessions.forEach(session => {
            if (session.metadata?.path) {
                paths.add(session.metadata.path);
            }
        });
        return Array.from(paths).sort();
    }, [machineSessions]);

    const pathsToShow = useMemo(() => {
        if (showAllPaths) return recentPaths;
        return recentPaths.slice(0, 5);
    }, [recentPaths, showAllPaths]);

    // Determine daemon status from metadata
    const daemonStatus = useMemo(() => {
        if (!machine) return 'unknown';

        // Check metadata for daemon status
        const metadata = machine.metadata as any;
        if (metadata?.daemonLastKnownStatus === 'shutting-down') {
            return 'stopped';
        }

        // Use machine online status as proxy for daemon status
        return isMachineOnline(machine) ? 'likely alive' : 'stopped';
    }, [machine]);

    // inline control below

    const handleRefresh = async () => {
        setIsRefreshing(true);
        await sync.refreshMachines();
        setIsRefreshing(false);
    };

    const handleStartSession = async (approvedNewDirectoryCreation: boolean = false): Promise<void> => {
        if (!machine || !machineId) return;
        try {
            const pathToUse = (customPath.trim() || '~');
            if (!isMachineOnline(machine)) return;
            setIsSpawning(true);
            const absolutePath = resolveAbsolutePath(pathToUse, machine?.metadata?.homeDir);
            const result = await machineSpawnNewSession({
                machineId: machineId!,
                directory: absolutePath,
                approvedNewDirectoryCreation
            });
            switch (result.type) {
                case 'success':
                    // Dismiss machine picker & machine detail screen
                    router.back();
                    router.back();
                    navigateToSession(result.sessionId);
                    break;
                case 'requestToApproveDirectoryCreation': {
                    const approved = await Modal.confirm('Create Directory?', `The directory '${result.directory}' does not exist. Would you like to create it?`, { cancelText: t('common.cancel'), confirmText: t('common.create') });
                    if (approved) {
                        await handleStartSession(true);
                    }
                    break;
                }
                case 'error':
                    Modal.alert(t('common.error'), result.errorMessage);
                    break;
            }
        } catch (error) {
            let errorMessage = 'Failed to start session. Make sure the daemon is running on the target machine.';
            if (error instanceof Error && !error.message.includes('Failed to spawn session')) {
                errorMessage = error.message;
            }
            Modal.alert(t('common.error'), errorMessage);
        } finally {
            setIsSpawning(false);
        }
    };

    const pastUsedRelativePath = useCallback((session: Session) => {
        if (!session.metadata) return 'unknown path';
        return formatPathRelativeToHome(session.metadata.path, session.metadata.homeDir);
    }, []);

    if (!machine) {
        return (
            <>
                <Stack.Screen
                    options={{
                        headerShown: true,
                        headerTitle: '',
                        headerBackTitle: t('machine.back')
                    }}
                />
                <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center' }}>
                    <Text style={[Typography.default(), { fontSize: 16, color: theme.colors.textSecondary }]}>
                        Machine not found
                    </Text>
                </View>
            </>
        );
    }

    const metadata = machine.metadata;
    const machineName = metadata?.displayName || metadata?.host || 'Paired computer';
    const settings = getCachedConnectionSettings();
    const relayUrl = getCachedHostedGrant(machineId!)?.relayUrl
        ?? (settings.machineId === machineId ? settings.relayUrl : undefined);

    const spawnButtonDisabled = !customPath.trim() || isSpawning || !isMachineOnline(machine!);

    return (
        <>
            <Stack.Screen
                options={{
                    headerShown: true,
                    headerTitle: () => (
                        <View style={{ alignItems: 'center' }}>
                            <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                                <Ionicons
                                    name="desktop-outline"
                                    size={18}
                                    color={theme.colors.header.tint}
                                    style={{ marginRight: 6 }}
                                />
                                <Text style={[Typography.default('semiBold'), { fontSize: 17, color: theme.colors.header.tint }]}>
                                    {machineName}
                                </Text>
                            </View>
                            <View style={{ flexDirection: 'row', alignItems: 'center', marginTop: 2 }}>
                                <View style={{
                                    width: 6,
                                    height: 6,
                                    borderRadius: 3,
                                    backgroundColor: isMachineOnline(machine) ? theme.colors.status.connected : theme.colors.status.disconnected,
                                    marginRight: 4
                                }} />
                                <Text style={[Typography.default(), {
                                    fontSize: 12,
                                    color: isMachineOnline(machine) ? theme.colors.status.connected : theme.colors.status.disconnected
                                }]}>
                                    {isMachineOnline(machine) ? t('status.online') : t('status.offline')}
                                </Text>
                            </View>
                        </View>
                    ),
                    headerBackTitle: t('machine.back')
                }}
            />
            <ItemList
                refreshControl={
                    <RefreshControl
                        refreshing={isRefreshing}
                        onRefresh={handleRefresh}
                    />
                }
                keyboardShouldPersistTaps="handled"
            >
                {/* Launch section */}
                {machine && (
                    <>
                        {!isMachineOnline(machine) && (
                            <ItemGroup>
                                <Item
                                    title={t('machine.offlineUnableToSpawn')}
                                    showChevron={false}
                                />
                            </ItemGroup>
                        )}
                        <ItemGroup title={t('machine.launchNewSessionInDirectory')}>
                        <View style={{ opacity: isMachineOnline(machine) ? 1 : 0.5 }}>
                            <View style={styles.pathInputContainer}>
                                <View style={[styles.pathInput, { paddingVertical: 8 }]}>
                                    <MultiTextInput
                                        ref={inputRef}
                                        value={customPath}
                                        onChangeText={setCustomPath}
                                        placeholder={'Enter custom path'}
                                        maxHeight={76}
                                        paddingTop={8}
                                        paddingBottom={8}
                                        paddingRight={48}
                                    />
                                    <Pressable
                                        onPress={() => handleStartSession()}
                                        disabled={spawnButtonDisabled}
                                        style={[
                                            styles.inlineSendButton,
                                            spawnButtonDisabled ? styles.inlineSendInactive : styles.inlineSendActive
                                        ]}
                                    >
                                        <Ionicons
                                            name="play"
                                            size={16}
                                            color={spawnButtonDisabled ? theme.colors.textSecondary : theme.colors.button.primary.tint}
                                            style={{ marginLeft: 1 }}
                                        />
                                    </Pressable>
                                </View>
                            </View>
                            <View style={{ paddingTop: 4 }} />
                            {pathsToShow.map((path, index) => {
                                const display = formatPathRelativeToHome(path, machine.metadata?.homeDir);
                                const isSelected = customPath.trim() === display;
                                const isLast = index === pathsToShow.length - 1;
                                const hideDivider = isLast && pathsToShow.length <= 5;
                                return (
                                    <Item
                                        key={path}
                                        title={display}
                                        leftElement={<Ionicons name="folder-outline" size={18} color={theme.colors.textSecondary} />}
                                        onPress={isMachineOnline(machine) ? () => {
                                            setCustomPath(display);
                                            setTimeout(() => inputRef.current?.focus(), 50);
                                        } : undefined}
                                        disabled={!isMachineOnline(machine)}
                                        selected={isSelected}
                                        showChevron={false}
                                        pressableStyle={isSelected ? {
                                            backgroundColor: Platform.select({
                                                web: theme.colors.surfaceSelected,
                                                default: theme.colors.glass.backgroundSubtle,
                                            }),
                                        } : undefined}
                                        showDivider={!hideDivider}
                                    />
                                );
                            })}
                            {recentPaths.length > 5 && (
                                <Item
                                    title={showAllPaths ? t('machineLauncher.showLess') : t('machineLauncher.showAll', { count: recentPaths.length })}
                                    onPress={() => setShowAllPaths(!showAllPaths)}
                                    showChevron={false}
                                    showDivider={false}
                                    titleStyle={{
                                        textAlign: 'center',
                                        color: (theme as any).dark ? theme.colors.button.primary.tint : theme.colors.button.primary.background
                                    }}
                                />
                            )}
                        </View>
                        </ItemGroup>
                    </>
                )}

                {collaborators.length > 0 && (
                    <ItemGroup title="Computer collaboration">
                        <Item
                            title={`Collaborates with ${formatNames(collaborators)}`}
                            subtitle="Computers connect directly; the phone is not required afterward"
                            icon={<Ionicons name="git-network-outline" size={28} color="#5856D6" />}
                            onPress={() => router.push('/settings/collaboration' as any)}
                        />
                    </ItemGroup>
                )}

                {/* Daemon */}
                <ItemGroup title={t('machine.daemon')}>
                        <Item
                            title={t('machine.status')}
                            detail={daemonStatus}
                            detailStyle={{
                                color: daemonStatus === 'likely alive' ? theme.colors.status.connected : theme.colors.box.warning.text
                            }}
                            showChevron={false}
                        />
                        {machine.daemonState && (
                            <>
                                {machine.daemonState.startTime && (
                                    <Item
                                        title={t('machine.startedAt')}
                                        subtitle={new Date(machine.daemonState.startTime).toLocaleString()}
                                    />
                                )}
                                {machine.daemonState.startedWithCliVersion && (
                                    <Item
                                        title={t('machine.cliVersion')}
                                        subtitle={machine.daemonState.startedWithCliVersion}
                                        subtitleStyle={{ fontFamily: 'Menlo', fontSize: 13 }}
                                    />
                                )}
                            </>
                        )}
                        {/* Pids, ports and state versions are diagnostics, not user copy — dev mode only. */}
                        {devModeEnabled && (
                            <>
                                {machine.daemonState?.pid && (
                                    <Item
                                        title={t('machine.lastKnownPid')}
                                        subtitle={String(machine.daemonState.pid)}
                                        subtitleStyle={{ fontFamily: 'Menlo', fontSize: 13 }}
                                    />
                                )}
                                {machine.daemonState?.httpPort && (
                                    <Item
                                        title={t('machine.lastKnownHttpPort')}
                                        subtitle={String(machine.daemonState.httpPort)}
                                        subtitleStyle={{ fontFamily: 'Menlo', fontSize: 13 }}
                                    />
                                )}
                                <Item
                                    title={t('machine.daemonStateVersion')}
                                    subtitle={String(machine.daemonStateVersion)}
                                />
                            </>
                        )}
                </ItemGroup>

                {/* Previous Sessions (debug view) */}
                {previousSessions.length > 0 && (
                    <ItemGroup title={'Previous Sessions (up to 5 most recent)'}>
                        {previousSessions.map(session => (
                            <Item
                                key={session.id}
                                title={getSessionName(session)}
                                subtitle={getSessionSubtitle(session)}
                                onPress={() => navigateToSession(session.id)}
                                rightElement={<Ionicons name="chevron-forward" size={20} color={theme.colors.groupped.chevron} />}
                            />
                        ))}
                    </ItemGroup>
                )}

                {/* Machine */}
                <ItemGroup title={t('machine.machineGroup')}>
                        {relayUrl && (
                            <>
                                <Item title="Transport" subtitle={pairingTransport(relayUrl) ?? 'Relay'} />
                                <Item title="Relay" subtitle={relayUrl} subtitleLines={0} />
                            </>
                        )}
                        {metadata?.muxrCliVersion && (
                            <Item title="muxr CLI" subtitle={metadata.muxrCliVersion} />
                        )}
                        <Item
                            title={t('machine.host')}
                            subtitle={metadata?.host || machineName}
                        />
                        {metadata?.username && (
                            <Item
                                title={t('machine.username')}
                                subtitle={metadata.username}
                            />
                        )}
                        {metadata?.homeDir && (
                            <Item
                                title={t('machine.homeDirectory')}
                                subtitle={metadata.homeDir}
                                subtitleStyle={{ fontFamily: 'Menlo', fontSize: 13 }}
                            />
                        )}
                        {metadata?.platform && (
                            <Item
                                title={t('machine.platform')}
                                subtitle={metadata.platform}
                            />
                        )}
                        {metadata?.arch && (
                            <Item
                                title={t('machine.architecture')}
                                subtitle={metadata.arch}
                            />
                        )}
                        <Item
                            title={t('machine.lastSeen')}
                            subtitle={machine.activeAt ? new Date(machine.activeAt).toLocaleString() : t('machine.never')}
                        />
                        {devModeEnabled && (
                            <Item
                                title={t('machine.metadataVersion')}
                                subtitle={String(machine.metadataVersion)}
                            />
                        )}
                </ItemGroup>
            </ItemList>
        </>
    );
}
