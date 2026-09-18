import { HomeNotices } from '@/components/VersionNotice';
/**
 * Phone/root Herd surface: live terminal previews, then the shared Spaces tree.
 * Split layouts mount that tree once in the permanent sidebar instead.
 */

import * as React from 'react';
import {
    View,
    NativeScrollEvent,
    NativeSyntheticEvent,
    Platform,
    ScrollView,
} from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Text } from '@/components/StyledText';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useHostedPairing, usePairQrScanner } from '@/pairing';
import { loadAppConfig } from '@/catalog';
import { getCachedConnectionSettings } from '@/connection';
import { setupEmptyState } from '@/commercialization';
import { RoundButton } from '@/components/RoundButton';
import { ActionButton } from '@/components/ActionButton';
import { withAlpha } from '@/components/ui';
import { useSocketStatus } from '@/catalog/store';
import { syncReconnect } from '@/catalog/sync';
import { hasAgent } from '../domain/herdTree';
import { HomeDiscoveryRows } from './HomeDiscoveryRows';
import { HomeRecoveryCard } from './HomeRecoveryCard';
import { LiveTerminalsRow } from './LiveTerminalsRow';
import { SpacesTree } from './SpacesTree';
import { useHerdTreeLive } from '../application/useHerdTreeLive';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import { layout } from '@/components/layout';
import { FirstRunSetupCard } from './FirstRunSetupCard';

const stylesheet = StyleSheet.create((theme) => ({
    container: {
        flex: 1,
        backgroundColor: theme.colors.groupped.background,
    },
    quietLine: {
        marginHorizontal: 16,
        marginTop: 8,
        color: theme.colors.textSecondary,
        fontSize: 13,
        lineHeight: 18,
        ...Typography.default(),
    },
    empty: {
        flex: 1,
        alignItems: 'center',
        justifyContent: 'center',
        gap: 8,
        padding: 32,
    },
    skeletonBlock: {
        marginHorizontal: 16,
        borderRadius: 12,
        backgroundColor: withAlpha(theme.colors.surfaceHigh, 0.6),
    },
    emptyText: {
        color: theme.colors.textSecondary,
        fontSize: 14,
        textAlign: 'center',
        ...Typography.default(),
    },
    emptyAction: {
        marginTop: 12,
        gap: 8,
    },
    routeHint: {
        fontSize: 13,
        lineHeight: 18,
        textAlign: 'center',
        color: theme.colors.textSecondary,
        ...Typography.default(),
    },
    setupTitle: {
        color: theme.colors.text,
        fontSize: 22,
        lineHeight: 28,
        textAlign: 'center',
        ...Typography.default('semiBold'),
    },
    error: {
        fontSize: 12,
        paddingHorizontal: 16,
        paddingTop: 8,
        ...Typography.default(),
    },
}));


export const HerdView = React.memo(({
    topContentInset = 0,
    bottomContentInset = 128,
    header,
    onScroll,
    onRecoveryChange,
    searchQuery = '',
    maxContentWidth = layout.maxWidth,
}: {
    topContentInset?: number;
    bottomContentInset?: number;
    header?: React.ReactNode;
    onScroll?: (event: NativeSyntheticEvent<NativeScrollEvent>) => void;
    onRecoveryChange?: (active: boolean) => void;
    searchQuery?: string;
    maxContentWidth?: number;
}) => {
    const { theme } = useUnistyles();
    const styles = stylesheet;
    const router = useRouter();
    const safeArea = useSafeAreaInsets();
    const {
        workspaces,
        loaded,
        attempted,
        error,
        herdrConnected,
        hasPairedGrant,
        machineName,
        defaultExpandedWorkspaceIds,
        refresh,
        refreshStatus,
    } = useHerdTreeLive();
    const processPairLink = useHostedPairing();
    const scanPairQr = usePairQrScanner((url) => void processPairLink(url));
    const socketStatus = useSocketStatus();
    const [retrying, setRetrying] = React.useState(false);
    const [retryFailed, setRetryFailed] = React.useState(false);
    const [recoveryFeedback, setRecoveryFeedback] = React.useState('');

    // "No agents anywhere" hides the whole list in favour of the friendly empty
    // state; the live strip already hides itself.
    // Shell-only spaces still list (and close) their panes, so "empty" means
    // herdr has no workspaces at all, not "no agents".
    const agentsEmpty = workspaces.length === 0;
    const noAgents = !workspaces.some(hasAgent);
    const setup = setupEmptyState(loadAppConfig().publicBaseUrl);
    const connection = getCachedConnectionSettings();
    // machines.list rejects while the host is down, and machineId falls back
    // to the build default on a fresh install — only the persisted pairing
    // grants can tell "never paired" from "paired but the machine is off".
    const neverPaired = connection.mode === 'hosted' && hasPairedGrant === false;
    const hostOffline = connection.mode === 'hosted' && hasPairedGrant === true && attempted
        && (socketStatus.status === 'error' || socketStatus.status === 'disconnected'
            || (socketStatus.status === 'connecting' && error !== null));
    const runtimeOffline = connection.mode === 'hosted' && hasPairedGrant === true
        && socketStatus.status === 'connected' && herdrConnected === false;
    React.useEffect(() => {
        if (socketStatus.status === 'connected' && error === null && !runtimeOffline) setRetryFailed(false);
    }, [error, runtimeOffline, socketStatus.status]);
    const needsRecovery = hostOffline || runtimeOffline || retrying || retryFailed;
    React.useEffect(() => {
        onRecoveryChange?.(needsRecovery);
        if (!needsRecovery) setRecoveryFeedback('');
        return () => onRecoveryChange?.(false);
    }, [needsRecovery, onRecoveryChange]);
    const retryConnection = async () => {
        if (retrying) return;
        setRetrying(true);
        setRecoveryFeedback('Checking the connection…');
        try {
            await syncReconnect();
            const result = await refreshStatus();
            if (result === false) throw new Error('host unavailable');
            setRetryFailed(false);
            setRecoveryFeedback('Connection restored.');
        } catch {
            setRetryFailed(true);
            setRecoveryFeedback('Still unavailable. Run the command on your computer, check its network, then retry.');
        } finally {
            setRetrying(false);
        }
    };
    const recoveryCard = needsRecovery ? (
        <HomeRecoveryCard
            mode={runtimeOffline && !hostOffline ? 'runtime' : 'host'}
            retrying={retrying}
            feedback={recoveryFeedback}
            onRetry={() => void retryConnection()}
            onFeedback={setRecoveryFeedback}
        />
    ) : null;

    // First paint draws the screen's known shape (design-system home.md §4):
    // three skeleton blocks at the gutter, no spinner.
    const skeleton = (
        <View style={[styles.container, { paddingTop: topContentInset + 8, gap: 14, paddingBottom: safeArea.bottom }]}>
            <View style={[styles.skeletonBlock, { height: 64 }]} />
            <View style={[styles.skeletonBlock, { height: 200 }]} />
            <View style={[styles.skeletonBlock, { height: 120 }]} />
        </View>
    );

    if (!loaded && !attempted) return skeleton;

    if (agentsEmpty) {
        if (connection.mode === 'hosted' && hasPairedGrant === undefined) {
            // Grant storage has not answered yet: showing either the onboarding
            // card or the error branch now would be a guess.
            return skeleton;
        }
        if (neverPaired) {
            return (
                <View style={[styles.empty, { paddingBottom: safeArea.bottom }]}>
                    <Ionicons name="desktop-outline" size={40} color={theme.colors.textSecondary} />
                    <Text style={styles.setupTitle}>{setup.title}</Text>
                    <FirstRunSetupCard />
                    <View style={styles.emptyAction}>
                        {Platform.OS === 'web' ? (
                            <>
                                <ActionButton title="Paste browser pairing link" icon="clipboard-outline" onPress={() => router.push('/pair')} />
                                <Text style={styles.routeHint}>Browsers pair by string: paste the link shown by `muxr pair --browser` on that computer.</Text>
                            </>
                        ) : (
                            <>
                                <ActionButton title="Scan pairing QR" icon="qr-code-outline" onPress={() => void scanPairQr()} />
                                <Text style={styles.routeHint}>Recommended · ~1 min · for the computer in front of you.</Text>
                                <ActionButton title="Enter pairing string" variant="secondary" icon="keypad-outline" onPress={() => router.push('/pair')} />
                                <Text style={styles.routeHint}>For a computer you are not standing at.</Text>
                            </>
                        )}
                    </View>
                </View>
            );
        }
        return (
            // Plugin surfaces live in the header. Someone with no agents is usually
            // a new user, who most needs to see that their plugins landed.
            <ScrollView
                style={{ flex: 1 }}
                contentContainerStyle={{ flexGrow: 1, paddingTop: topContentInset, paddingBottom: bottomContentInset + safeArea.bottom }}
                onScroll={onScroll}
                scrollEventThrottle={16}
            >
                <HomeNotices runtimeOffline={herdrConnected === false && !needsRecovery} machineName={machineName} />
                {header}
                {recoveryCard}
                {!needsRecovery && searchQuery.trim() === '' && <LiveTerminalsRow
                    visibilityTop={topContentInset}
                    visibilityBottomInset={bottomContentInset}
                />}
            {!needsRecovery && searchQuery.trim() === '' ? <HomeDiscoveryRows /> : null}
            {needsRecovery ? (
                <Text style={styles.quietLine}>Your terminals will reappear when the computer reconnects.</Text>
            ) : error !== null ? (
                <View style={styles.empty}>
                    <Text style={styles.emptyText}>{error}</Text>
                    <View style={styles.emptyAction}>
                        <RoundButton
                            title="Set up connection"
                            size="normal"
                            onPress={() => router.push('/settings/connection' as any)}
                        />
                    </View>
                </View>
            ) : (
                <Text style={styles.quietLine}>
                    {searchQuery.trim() !== '' ? 'No matches' : t('spacesTree.empty')}
                </Text>
            )}
            </ScrollView>
        );
    }

    return (
        <View style={styles.container}>
            {error === null || needsRecovery ? null : (
                <Text style={[styles.error, { color: theme.colors.status.error }]}>{error}</Text>
            )}
            <SpacesTree
                workspaces={workspaces}
                defaultExpandedWorkspaceIds={defaultExpandedWorkspaceIds}
                refresh={refresh}
                searchQuery={searchQuery}
                listHeaderComponent={<>
                    <HomeNotices runtimeOffline={herdrConnected === false && !needsRecovery} machineName={machineName} />
                    {header}
                    {recoveryCard}
                    {!needsRecovery && searchQuery.trim() === '' && <LiveTerminalsRow
                        visibilityTop={topContentInset}
                        visibilityBottomInset={bottomContentInset}
                    />}
                    {noAgents && !needsRecovery && searchQuery.trim() === '' ? <HomeDiscoveryRows /> : null}
                </>}
                topContentInset={topContentInset}
                bottomContentInset={safeArea.bottom + bottomContentInset}
                maxContentWidth={maxContentWidth}
                onScroll={onScroll}
            />
        </View>
    );
});
