import * as React from 'react';
import { Pressable, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { Text } from '@/components/StyledText';
import { Typography } from '@/constants/Typography';
import { useDeviceAuthority } from '@/pairing';
import { useSocketStatus } from '@/catalog/store';

const styles = StyleSheet.create((theme) => ({
    container: { width: '100%', maxWidth: 800, alignSelf: 'center', paddingHorizontal: 16, marginTop: 12, gap: 8 },
    row: { flexDirection: 'row', alignItems: 'center', gap: 12, borderRadius: 12, padding: 14, backgroundColor: theme.colors.surfaceHigh },
    title: { color: theme.colors.text, fontSize: 14, ...Typography.default('semiBold') },
    breadcrumb: { color: theme.colors.textSecondary, fontSize: 12, lineHeight: 16, ...Typography.default() },
}));

export function HomeDiscoveryRows() {
    const router = useRouter();
    const { theme } = useUnistyles();
    const { authority, loading } = useDeviceAuthority();
    const connected = useSocketStatus().status === 'connected';
    const rows = [
        ...(connected && !loading && authority === 'control' ? [{ title: 'Start an agent', location: 'New agent · choose computer', icon: 'add-circle-outline' as const, href: '/new-agent' }] : []),
        { title: 'Connect another computer', location: 'Settings · connection', icon: 'desktop-outline' as const, href: '/settings/connection' },
    ];
    return (
        <View style={styles.container}>
            {rows.map((row) => (
                <Pressable key={row.href} accessibilityRole="button" accessibilityLabel={row.title} onPress={() => router.push(row.href as never)} style={styles.row}>
                    <Ionicons name={row.icon} size={23} color={theme.colors.accent} />
                    <View style={{ flex: 1 }}>
                        <Text style={styles.title}>{row.title}</Text>
                        <Text style={styles.breadcrumb}>{row.location}</Text>
                    </View>
                    <Ionicons name="chevron-forward" size={17} color={theme.colors.textSecondary} />
                </Pressable>
            ))}
        </View>
    );
}
