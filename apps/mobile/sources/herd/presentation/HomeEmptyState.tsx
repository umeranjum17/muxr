import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Ionicons } from '@expo/vector-icons';
import { Text } from '@/components/StyledText';
import { Typography } from '@/constants/Typography';
import { useDeviceAuthority } from '@/pairing';
import { t } from '@/text';
import { HomeDiscoveryRows } from './HomeDiscoveryRows';

const styles = StyleSheet.create((theme) => ({
    container: { flexGrow: 1, justifyContent: 'center', paddingVertical: 32, gap: 6 },
    mark: { alignSelf: 'center', width: 48, height: 48, borderRadius: 24, alignItems: 'center', justifyContent: 'center', marginBottom: 6, backgroundColor: theme.colors.surfaceHigh },
    title: { color: theme.colors.text, fontSize: 17, lineHeight: 22, textAlign: 'center', ...Typography.default('semiBold') },
    body: { color: theme.colors.textSecondary, fontSize: 13, lineHeight: 18, textAlign: 'center', paddingHorizontal: 32, ...Typography.default() },
    actions: { width: '100%', maxWidth: 480, alignSelf: 'center', marginTop: 6 },
}));

/**
 * Home with no spaces open: one composition centred in the room below the
 * strip, a mark, what is missing and what comes next, with the ways forward
 * as its actions. Phone and wide Home both draw it, so neither ends in a
 * stray line over an empty page.
 */
export function HomeEmptyState() {
    const { theme } = useUnistyles();
    const { authority, loading } = useDeviceAuthority();
    const canStart = !loading && authority === 'control';
    return (
        <View style={styles.container}>
            <View style={styles.mark}>
                <Ionicons name="layers-outline" size={22} color={theme.colors.textSecondary} />
            </View>
            <Text accessibilityRole="header" style={styles.title}>{t('spacesTree.empty')}</Text>
            <Text style={styles.body}>{t(canStart ? 'homeNotices.emptyStart' : 'homeNotices.emptyWatch')}</Text>
            <View style={styles.actions}>
                <HomeDiscoveryRows />
            </View>
        </View>
    );
}
