import * as React from 'react';
import { Text, View, Pressable } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { usePathname, useRouter } from 'expo-router';
import { useHeaderHeight } from '@/utils/responsive';
import { SpacesTree } from './SpacesTree';
import { StyleSheet } from 'react-native-unistyles';
import { t } from '@/text';
import { Ionicons } from '@expo/vector-icons';
import { Typography } from '@/constants/Typography';
import { ShortcutHintBadge, useShortcutHints } from '@/components/ShortcutHints';
import { useDeviceAuthority } from '@/pairing';
import { useHerdTreeLive } from '../application/useHerdTreeLive';
import { DeclarativeNavigationItems } from '@/plugins/ui';
import { pluginHref } from '@/plugins';

const stylesheet = StyleSheet.create((theme) => ({
    container: {
        flex: 1,
        borderStyle: 'solid',
        backgroundColor: theme.colors.groupped.background,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: theme.colors.divider,
    },
    newSessionButton: {
        flex: 1,
        flexDirection: 'row',
        alignItems: 'center',
        paddingVertical: 10,
        paddingHorizontal: 14,
        borderRadius: 10,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: theme.colors.divider,
        backgroundColor: theme.colors.surface,
        gap: 8,
    },
    headerRow: {
        flexDirection: 'row',
        alignItems: 'center',
        marginHorizontal: 16,
        marginTop: 8,
        marginBottom: 4,
        gap: 8,
    },
    newSessionButtonPressed: {
        backgroundColor: theme.colors.surfacePressed,
    },
    shortcutTargetActive: {
        backgroundColor: theme.colors.surfacePressed,
    },
    newSessionText: {
        fontSize: 14,
        fontWeight: '500',
        color: theme.colors.text,
        ...Typography.default('semiBold'),
    },
    accessHint: {
        marginLeft: 'auto',
        fontSize: 11,
        color: theme.colors.textSecondary,
        ...Typography.default(),
    },
    treeNotice: {
        marginHorizontal: 10,
        marginTop: 8,
        paddingHorizontal: 10,
        paddingVertical: 8,
        borderRadius: 8,
        color: theme.colors.textSecondary,
        backgroundColor: theme.colors.surfaceHigh,
        fontSize: 12,
        ...Typography.default(),
    },
    toolsSection: {
        paddingHorizontal: 10,
        paddingTop: 14,
        paddingBottom: 10,
    },
    toolsTitle: {
        paddingHorizontal: 6,
        paddingBottom: 4,
        fontSize: 12,
        fontWeight: '600',
        color: theme.colors.groupped.sectionTitle,
        letterSpacing: 0.2,
        textTransform: 'uppercase',
        ...Typography.default('semiBold'),
    },
    settingsRow: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: 16,
        paddingVertical: 14,
        borderTopWidth: StyleSheet.hairlineWidth,
        borderTopColor: theme.colors.divider,
        gap: 10,
    },
    settingsText: {
        fontSize: 14,
        fontWeight: '500',
        color: theme.colors.text,
        ...Typography.default(),
    },
    shortcutBadgeInline: {
        marginLeft: 'auto',
    },
}));

export const SidebarView = React.memo(() => {
    const styles = stylesheet;
    const safeArea = useSafeAreaInsets();
    const router = useRouter();
    const headerHeight = useHeaderHeight();
    const { visible: shortcutHintsVisible } = useShortcutHints();
    const pathname = usePathname();
    const { authority, loading: authorityLoading } = useDeviceAuthority();
    const {
        workspaces,
        loaded,
        attempted,
        error,
        herdrConnected,
        defaultExpandedWorkspaceIds,
        refresh,
    } = useHerdTreeLive();
    const selectedSessionId = pathname.startsWith('/session/')
        ? pathname.split('/')[2]
        : undefined;
    const newSessionDisabled = authorityLoading || authority !== 'control';
    const emptyText = !loaded && !attempted
        ? 'Loading spaces…'
        : herdrConnected === false
            ? 'Reconnecting…'
            : 'No spaces open';

    const handleNewSession = React.useCallback(() => {
        router.navigate('/new-agent');
    }, [router]);

    return (
        <View style={[styles.container, { paddingTop: safeArea.top + headerHeight }]}>
            <View style={styles.headerRow}>
                <Pressable
                    onPress={handleNewSession}
                    disabled={newSessionDisabled}
                    accessibilityRole="button"
                    accessibilityState={{ disabled: newSessionDisabled }}
                    style={({ pressed }) => [
                        styles.newSessionButton,
                        shortcutHintsVisible && styles.shortcutTargetActive,
                        pressed && styles.newSessionButtonPressed,
                        newSessionDisabled && { opacity: 0.55 },
                    ]}
                >
                    <Ionicons name="create-outline" size={16} color={stylesheet.newSessionText.color} />
                    <Text style={styles.newSessionText}>{t('sidebar.newSession')}</Text>
                    {newSessionDisabled ? (
                        <Text style={styles.accessHint}>{authorityLoading ? 'Checking access…' : 'View only'}</Text>
                    ) : (
                        <ShortcutHintBadge shortcutKey="N" style={styles.shortcutBadgeInline} />
                    )}
                </Pressable>
            </View>

            <SpacesTree
                workspaces={workspaces}
                defaultExpandedWorkspaceIds={defaultExpandedWorkspaceIds}
                refresh={refresh}
                density="compact"
                selectedSessionId={selectedSessionId}
                emptyText={emptyText}
                listHeaderComponent={error !== null || herdrConnected === false ? (
                    <Text style={styles.treeNotice}>
                        {error ?? 'Agent runtime is reconnecting. Sessions may be stale.'}
                    </Text>
                ) : undefined}
            />
            <View style={styles.toolsSection}>
                <Text style={styles.toolsTitle}>Tools</Text>
                <DeclarativeNavigationItems
                    compact
                    onSelect={(_key, pluginId, contentId) => router.push(pluginHref(pluginId, contentId))}
                />
            </View>

            {/* Settings at bottom */}
            <Pressable
                onPress={() => router.push('/settings')}
                style={[
                    styles.settingsRow,
                    shortcutHintsVisible && styles.shortcutTargetActive,
                ]}
            >
                <Ionicons name="settings-outline" size={18} color={stylesheet.settingsText.color} />
                <Text style={styles.settingsText}>{t('settings.title')}</Text>
                <ShortcutHintBadge shortcutKey="," style={styles.shortcutBadgeInline} />
            </Pressable>
        </View>
    );
});
