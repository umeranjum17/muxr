import { VersionNotice } from '@/components/VersionNotice';
/**
 * Phone/root Herd surface: live terminal previews, then the shared Spaces tree.
 * Split layouts mount that tree once in the permanent sidebar instead.
 */

import * as React from 'react';
import {
    Pressable,
    View,
    NativeScrollEvent,
    NativeSyntheticEvent,
    Platform,
} from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Text } from '@/components/StyledText';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useHostedPairing, usePairQrScanner } from '@/pairing';
import * as Clipboard from 'expo-clipboard';
import { loadAppConfig } from '@/catalog/infrastructure/appConfig';
import { getCachedConnectionSettings } from '@/connection';
import { openExternalUrl } from '@/utils/openExternalUrl';
import { setupEmptyState } from '@/commercialization';
import { RoundButton } from '@/components/RoundButton';
import { ActionButton } from '@/components/ActionButton';
import { LiveTerminalsRow } from './LiveTerminalsRow';
import { SpacesTree } from './SpacesTree';
import { useHerdTreeLive } from '../application/useHerdTreeLive';
import { useSocketStatus } from '@/catalog/store';
import { Typography } from '@/constants/Typography';
import { layout } from '@/components/layout';
import { LoadingHairline } from '@/components/LoadingHairline';

const stylesheet = StyleSheet.create((theme) => ({
    container: {
        flex: 1,
        backgroundColor: theme.colors.groupped.background,
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
        gap: 8,
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


/** Warning row with the copyable command chip the setup card already uses. */
function RecoveryBanner({ text, command }: { text: string; command?: string }) {
    const { theme } = useUnistyles();
    const styles = stylesheet;
    return (
        <View style={styles.banner} accessibilityRole="alert">
            <Ionicons name="warning-outline" size={16} color={theme.colors.box.warning.text} />
            <View style={{ flex: 1, gap: 4 }}>
                <Text style={[styles.bannerText, { color: theme.colors.box.warning.text }]}>{text}</Text>
                {command !== undefined && (
                    <View style={styles.commandRow}>
                        <Text style={styles.setupCommand} selectable>{command}</Text>
                        <Pressable
                            accessibilityRole="button"
                            accessibilityLabel={`Copy ${command}`}
                            hitSlop={10}
                            style={styles.copyButton}
                            onPress={() => void Clipboard.setStringAsync(command)}
                        >
                            <Ionicons name="copy-outline" size={17} color={theme.colors.textSecondary} />
                        </Pressable>
                    </View>
                )}
            </View>
        </View>
    );
}

export const HerdView = React.memo(({
    topContentInset = 0,
    bottomContentInset = 128,
    header,
    onScroll,
    searchQuery = '',
    maxContentWidth = layout.maxWidth,
}: {
    topContentInset?: number;
    bottomContentInset?: number;
    header?: React.ReactNode;
    onScroll?: (event: NativeSyntheticEvent<NativeScrollEvent>) => void;
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
        defaultExpandedWorkspaceIds,
        refresh,
    } = useHerdTreeLive();
    const processPairLink = useHostedPairing();
    const scanPairQr = usePairQrScanner((url) => void processPairLink(url));
    const { status: socketStatus } = useSocketStatus();
    // One banner under the header for everything that makes the herd below
    // stale: the machine's runtime not answering (with the command that
    // brings it back), or this device being offline. Nothing is hidden and
    // nothing is queued for replay; the data stays as last known.
    const recovery = herdrConnected === false
        ? <RecoveryBanner text="This computer is online, but its agent runtime (herdr) is not answering, so what you see may be stale. Run this on the computer:" command="herdr server" />
        : (socketStatus === 'disconnected' || socketStatus === 'error') && loaded
            ? <RecoveryBanner text="Offline. Showing what was last known." />
            : null;

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

    // First load and the grant-storage wait both keep the shell: header,
    // captions and dock stay put and a hairline says the herd is coming.
    if ((!loaded && !attempted) || (agentsEmpty && connection.mode === 'hosted' && hasPairedGrant === undefined)) {
        return (
            <View style={{ flex: 1, paddingBottom: safeArea.bottom }}>
                <LoadingHairline active />
            </View>
        );
    }

    if (agentsEmpty) {
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
                                Choose this network, Tailscale, or your secure relay
                            </Text>
                        </View>
                        <View style={[styles.setupStep, { marginBottom: 0 }]}>
                            <View style={styles.stepBadge}><Text style={styles.stepNumber}>3</Text></View>
                            <Text style={[styles.stepText, styles.stepTextInline]}>Scan the QR code with this phone</Text>
                        </View>
                    </View>
                    <View style={styles.emptyAction}>
                        {Platform.OS === 'web' ? (
                            <ActionButton title="Scan QR to pair" icon="qr-code-outline" onPress={() => router.push('/pair')} />
                        ) : (
                            <>
                                <ActionButton title="Scan pairing QR" icon="qr-code-outline" onPress={() => void scanPairQr()} />
                                <ActionButton title="Enter pairing string" variant="secondary" icon="keypad-outline" onPress={() => router.push('/pair')} />
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
                <VersionNotice />
                {header}
                <LiveTerminalsRow
                    showZeroState={false}
                    visibilityTop={topContentInset}
                    visibilityBottomInset={bottomContentInset}
                />
            {recovery}
            <View style={[styles.empty, { paddingBottom: safeArea.bottom }]}>
                <Ionicons name="albums-outline" size={40} color={theme.colors.textSecondary} />
                <Text style={styles.emptyText}>
                    {error !== null
                        ? error
                        : searchQuery.trim() !== ''
                            ? 'No matches'
                            : 'No agents yet — start one below.'}
                </Text>
                {error === null ? null : (
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
            {recovery}
            <SpacesTree
                workspaces={workspaces}
                defaultExpandedWorkspaceIds={defaultExpandedWorkspaceIds}
                refresh={refresh}
                searchQuery={searchQuery}
                listHeaderComponent={<>
                    <VersionNotice />
                    {header}
                    <LiveTerminalsRow
                        visibilityTop={topContentInset}
                        visibilityBottomInset={bottomContentInset}
                    />
                </>}
                topContentInset={topContentInset}
                bottomContentInset={safeArea.bottom + bottomContentInset}
                maxContentWidth={maxContentWidth}
                onScroll={onScroll}
            />
        </View>
    );
});
