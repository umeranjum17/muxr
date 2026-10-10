import * as React from 'react';
import { Platform, Pressable, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import { useMachine } from '@/catalog/store';
import { getCachedConnectionSettings } from '@/connection';
import { getAppVersion } from '@/utils/appVersion';
import { versionsMismatch } from '@/utils/versionStatus';

/**
 * A version difference is chronic and low-urgency, so it never takes the top
 * slot: one quiet line (secondary text, no card, no dot, no chevron) at the
 * foot of Home. The whole line is the action, opening the versions screen.
 */
const stylesheet = StyleSheet.create((theme) => ({
    line: {
        marginHorizontal: 16,
        marginTop: 8,
        paddingVertical: 6,
    },
    text: {
        color: theme.colors.textSecondary,
        fontSize: 13,
        lineHeight: 18,
        ...Typography.default(),
    },
    // The runtime notice keeps the spine's quiet card (design-system home.md §3.2).
    card: {
        minHeight: 52,
        padding: 14,
        flexDirection: 'row',
        alignItems: 'flex-start',
        gap: 8,
    },
    dot: { width: 6, height: 6, borderRadius: 3, backgroundColor: theme.colors.box.warning.text, marginTop: 6 },
    cardText: { flex: 1, color: theme.colors.text, fontSize: 13, lineHeight: 18 },
}));

/**
 * The app and the computer run different versions: one quiet line, the whole
 * line a tap to the only detailed version/support screen.
 */
export function VersionNotice() {
    const { theme } = useUnistyles();
    const router = useRouter();
    const machine = useMachine(getCachedConnectionSettings().machineId);
    if (!versionsMismatch(getAppVersion(), machine?.metadata?.muxrCliVersion)) return null;
    return (
        <Pressable
            accessibilityRole="button"
            accessibilityLabel={`${t('homeNotices.versions')}. ${t('homeNotices.reviewUpdates')}.`}
            onPress={() => router.push('/settings/connection')}
            hitSlop={{ top: 8, bottom: 8 }}
            style={({ pressed }) => [stylesheet.line, pressed && Platform.select({ android: {}, default: { opacity: 0.75 } })]}
            android_ripple={{ color: theme.colors.surfaceRipple, foreground: true }}
        >
            <Text numberOfLines={2} style={stylesheet.text}>
                {t('homeNotices.versions')}
                <Text> · {t('homeNotices.reviewUpdates')}</Text>
            </Text>
        </Pressable>
    );
}

/** The runtime notice: no action, no chevron — the sentence is the whole card. */
export function RuntimeNotice({ machineName }: { machineName?: string }) {
    const { theme } = useUnistyles();
    return (
        <View style={stylesheet.card}>
            <View style={stylesheet.dot} />
            <Text numberOfLines={2} style={stylesheet.cardText}>
                {t('homeNotices.runtimeOffline', { name: machineName ?? 'Paired computer' })}
                <Text style={{ color: theme.colors.textSecondary }}> · {t('homeNotices.runtimeStale')}</Text>
            </Text>
        </View>
    );
}

/** The runtime notice still leads Home; the version line lives at its foot. */
export function HomeNotices({ runtimeOffline, machineName }: { runtimeOffline: boolean; machineName?: string }) {
    if (!runtimeOffline) return null;
    return (
        <View style={{ marginHorizontal: 16, marginTop: 8, marginBottom: 12 }}>
            <RuntimeNotice machineName={machineName} />
        </View>
    );
}
