import * as React from 'react';
import { Platform, Pressable, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { cardStyle, withAlpha } from '@/components/ui';
import { t } from '@/text';
import { useMachine } from '@/catalog/store';
import { getCachedConnectionSettings } from '@/connection';
import { getAppVersion } from '@/utils/appVersion';
import { versionsMismatch } from '@/utils/versionStatus';

/**
 * The two Home notices, drawn as the spine's one quiet card (design-system
 * home.md §3.2): a 6pt dot carries the colour, the sentence stays 13/18 body
 * text with the reason after " · " in secondary. The version notice is the
 * only one with an action, so it is the only one with a chevron.
 */
const stylesheet = StyleSheet.create((theme) => ({
    card: {
        minHeight: 52,
        padding: 14,
        flexDirection: 'row',
        alignItems: 'flex-start',
        gap: 8,
    },
    dot: { width: 6, height: 6, borderRadius: 3, backgroundColor: theme.colors.box.warning.text, marginTop: 6 },
    text: { flex: 1, color: theme.colors.text, fontSize: 13, lineHeight: 18 },
    chevron: { marginTop: 2 },
}));

function NoticeSentence({ text, sub, chevron }: { text: string; sub?: string; chevron?: boolean }) {
    const { theme } = useUnistyles();
    return (
        <>
            <View style={stylesheet.dot} />
            <Text numberOfLines={2} style={stylesheet.text}>
                {text}
                {sub === undefined ? null : <Text style={{ color: theme.colors.textSecondary }}> · {sub}</Text>}
            </Text>
            {chevron ? <Ionicons name="chevron-forward" size={14} color={withAlpha(theme.colors.textSecondary, 0.6)} style={stylesheet.chevron} /> : null}
        </>
    );
}

/** Visible at Home, with one tap to the only detailed version/support screen. */
export function VersionNotice() {
    const { theme } = useUnistyles();
    const router = useRouter();
    const machine = useMachine(getCachedConnectionSettings().machineId);
    if (!versionsMismatch(getAppVersion(), machine?.metadata?.muxrCliVersion)) return null;
    return (
        <Pressable
            accessibilityRole="button"
            accessibilityLabel="App and host versions differ. Review updates."
            onPress={() => router.push('/settings/connection')}
            style={({ pressed }) => [stylesheet.card, cardStyle(theme), pressed && Platform.select({ android: {}, default: { opacity: 0.75 } })]}
            android_ripple={{ color: theme.colors.surfaceRipple, foreground: true }}
        >
            <NoticeSentence text={t('homeNotices.versions')} sub={t('homeNotices.reviewUpdates')} chevron />
        </Pressable>
    );
}

/** The runtime notice: no action, no chevron — the sentence is the whole card. */
export function RuntimeNotice({ machineName }: { machineName?: string }) {
    return (
        <View style={stylesheet.card}>
            <NoticeSentence
                text={t('homeNotices.runtimeOffline', { name: machineName ?? 'Paired computer' })}
                sub={t('homeNotices.runtimeStale')}
            />
        </View>
    );
}

/** Both notices in the document's order, above the first Home section. */
export function HomeNotices({ runtimeOffline, machineName }: { runtimeOffline: boolean; machineName?: string }) {
    const machine = useMachine(getCachedConnectionSettings().machineId);
    const versionMismatch = versionsMismatch(getAppVersion(), machine?.metadata?.muxrCliVersion);
    if (!versionMismatch && !runtimeOffline) return null;
    return (
        <View style={{ marginHorizontal: 16, marginTop: 8, marginBottom: 12, gap: 8 }}>
            {versionMismatch ? <VersionNotice /> : null}
            {runtimeOffline ? <RuntimeNotice machineName={machineName} /> : null}
        </View>
    );
}
