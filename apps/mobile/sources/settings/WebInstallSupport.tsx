import * as React from 'react';
import { Platform, Pressable, ScrollView, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Item } from '@/components/Item';
import { ItemGroup } from '@/components/ItemGroup';
import { Typography } from '@/constants/Typography';
import { Modal } from '@/modal';
import { t } from '@/text';
import { getWebInstallState, promptWebInstall, subscribeWebInstall, type WebInstallState } from '@/utils/webInstall';

function useWebInstallState(): WebInstallState {
    return React.useSyncExternalStore(subscribeWebInstall, getWebInstallState, getWebInstallState);
}

/**
 * The install affordance for a browser tab, sitting next to the versions card
 * and the display-mode detection it builds on. Chromium rows hand the held
 * install prompt back on tap; iOS has no prompt API, so its row opens the
 * Add to Home Screen guide the person has to walk through themselves.
 * Nothing renders once installed, on native, or in a browser with no path.
 */
export function WebInstallSupport() {
    const { theme } = useUnistyles();
    const state = useWebInstallState();
    const [busy, setBusy] = React.useState(false);
    if (state !== 'ready' && state !== 'ios-guide') return null;
    const install = async () => {
        if (state === 'ios-guide') {
            Modal.show({ component: WebInstallGuideSheet, align: 'bottom' });
            return;
        }
        setBusy(true);
        try {
            await promptWebInstall();
        } finally {
            setBusy(false);
        }
    };
    return (
        <ItemGroup title={t('webInstall.groupTitle')}>
            <Item
                title={t('webInstall.rowTitle')}
                subtitle={state === 'ios-guide' ? t('webInstall.iosSubtitle') : t('webInstall.browserSubtitle')}
                subtitleLines={0}
                loading={busy}
                icon={<Ionicons name="download-outline" size={24} color={theme.colors.header.tint} />}
                onPress={() => void install()}
            />
        </ItemGroup>
    );
}

/** The iOS-only walk through Safari's Share menu, in plain words. */
export function WebInstallGuideSheet({ onClose }: { onClose?: () => void }) {
    return (
        <View style={styles.sheet}>
            <View style={styles.handleRow}>
                <View style={styles.handle} />
            </View>
            <Text style={styles.title} accessibilityRole="header">{t('webInstall.guideTitle')}</Text>
            <ScrollView style={styles.body} contentContainerStyle={styles.bodyContent} keyboardShouldPersistTaps="handled">
                <Text style={styles.lead}>{t('webInstall.guideLead')}</Text>
                <View style={styles.steps}>
                    <Text style={styles.stepsText}>{t('webInstall.guideSteps')}</Text>
                </View>
                <View style={styles.benefit}>
                    <Ionicons name="notifications-outline" size={18} color="#007AFF" />
                    <Text style={styles.benefitText}>{t('webInstall.guideBenefit')}</Text>
                </View>
                <Pressable
                    onPress={onClose}
                    accessibilityRole="button"
                    accessibilityLabel={t('webInstall.guideClose')}
                    style={({ pressed }) => [styles.closeButton, pressed && styles.pressed]}
                >
                    <Text style={styles.closeText}>{t('webInstall.guideClose')}</Text>
                </Pressable>
            </ScrollView>
        </View>
    );
}

const styles = StyleSheet.create((theme) => ({
    sheet: {
        width: '100%',
        maxWidth: 560,
        alignSelf: 'center',
        // Tall content scrolls inside instead of pushing past a short screen.
        maxHeight: '82%',
        backgroundColor: theme.colors.groupped.background,
        borderTopLeftRadius: 24,
        borderTopRightRadius: 24,
        overflow: 'hidden',
    },
    handleRow: { alignItems: 'center', paddingTop: 8 },
    handle: { width: 36, height: 4, borderRadius: 2, backgroundColor: theme.colors.textSecondary, opacity: 0.5 },
    title: {
        fontSize: 22,
        color: theme.colors.text,
        paddingHorizontal: 20,
        paddingTop: 12,
        paddingBottom: 4,
        ...Typography.default('semiBold'),
    },
    body: { flexGrow: 0, flexShrink: 1 },
    bodyContent: { paddingHorizontal: 20, paddingTop: 8, paddingBottom: 24, gap: 14 },
    lead: { fontSize: 15, lineHeight: 22, color: theme.colors.text, ...Typography.default() },
    steps: { backgroundColor: theme.colors.surfaceHigh, borderRadius: 12, paddingHorizontal: 14, paddingVertical: 12 },
    stepsText: { fontSize: 15, lineHeight: 26, color: theme.colors.text, ...Typography.default() },
    benefit: {
        flexDirection: 'row',
        alignItems: 'flex-start',
        gap: 8,
        backgroundColor: theme.colors.surfaceHigh,
        borderRadius: 12,
        paddingHorizontal: 14,
        paddingVertical: 12,
    },
    benefitText: { flex: 1, minWidth: 0, fontSize: 14, lineHeight: 20, color: theme.colors.textSecondary, ...Typography.default() },
    pressed: { opacity: 0.6 },
    closeButton: { alignItems: 'center', borderRadius: 12, paddingVertical: 12 },
    closeText: { fontSize: 16, color: theme.colors.textLink, ...Typography.default('semiBold') },
}));
