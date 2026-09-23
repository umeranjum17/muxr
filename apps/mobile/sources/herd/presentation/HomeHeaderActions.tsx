import * as React from 'react';
import { Platform, Pressable, Text, View, useWindowDimensions } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { HeaderLogo } from '@/components/HeaderLogo';
import { StatusDot } from '@/components/StatusDot';
import { Typography } from '@/constants/Typography';
import { MobileGlassSurface } from '@/components/MobileGlass';
import { t } from '@/text';

const styles = StyleSheet.create(() => ({
    actions: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 4,
    },
    actionsCompact: { gap: 6, paddingHorizontal: 4, marginHorizontal: -4 },
    target: {
        width: 44,
        height: 44,
        alignItems: 'center',
        justifyContent: 'center',
    },
    targetCompact: { marginHorizontal: -4 },
    glass: {
        width: 40,
        height: 40,
        borderRadius: 20,
        overflow: 'hidden',
    },
    glassCompact: {
        width: 36,
        height: 36,
        borderRadius: 18,
    },
    content: {
        width: '100%',
        height: '100%',
        alignItems: 'center',
        justifyContent: 'center',
    },
    status: {
        flexDirection: 'row',
        alignItems: 'center',
        maxWidth: '100%',
        minWidth: 0,
        marginTop: -2,
    },
    statusText: {
        flexShrink: 1,
        fontSize: Platform.OS === 'web' ? 12 : 11,
        fontWeight: '500',
        lineHeight: 16,
        ...Typography.default(),
    },
    tabletStatusText: { fontSize: 13, lineHeight: 18 },
}));

export const HomeHeaderActions = React.memo(({
    searchActive,
    onSearchPress,
}: {
    searchActive: boolean;
    onSearchPress: () => void;
}) => {
    const router = useRouter();
    const { theme } = useUnistyles();
    const compact = useWindowDimensions().width < 330;
    const glass = [styles.glass, compact && styles.glassCompact];
    const target = [styles.target, compact && styles.targetCompact];

    return (
        <View style={[styles.actions, compact && styles.actionsCompact]}>
            <Pressable
                onPress={() => router.push('/panes')}
                style={target}
                accessibilityRole="button"
                accessibilityLabel="Panes"
            >
                {({ pressed }) => (
                    <MobileGlassSurface nativeEffect interactive pressed={pressed} pointerEvents="none" style={glass}>
                        <View style={styles.content}>
                            <Ionicons name="grid-outline" size={21} color={theme.colors.header.tint} />
                        </View>
                    </MobileGlassSurface>
                )}
            </Pressable>
            <Pressable
                onPress={onSearchPress}
                style={target}
                accessibilityRole="button"
                accessibilityLabel={t('tools.names.search')}
            >
                {({ pressed }) => (
                    <MobileGlassSurface nativeEffect interactive pressed={pressed} pointerEvents="none" style={glass}>
                        <View style={styles.content}>
                            <Ionicons name={searchActive ? 'close' : 'search'} size={searchActive ? 24 : 21} color={theme.colors.header.tint} />
                        </View>
                    </MobileGlassSurface>
                )}
            </Pressable>
            <Pressable
                onPress={() => router.push('/settings')}
                style={target}
                accessibilityRole="button"
                accessibilityLabel={t('settings.title')}
            >
                {({ pressed }) => (
                    <MobileGlassSurface nativeEffect interactive pressed={pressed} pointerEvents="none" style={glass}>
                        <View style={styles.content}>
                            <Ionicons name="settings-outline" size={21} color={theme.colors.header.tint} />
                        </View>
                    </MobileGlassSurface>
                )}
            </Pressable>
        </View>
    );
});

export const HomeHeaderStatus = React.memo(({ text, color, isPulsing, large = false }: {
    text: string;
    color: string;
    isPulsing: boolean;
    large?: boolean;
}) => (
    <View style={styles.status}>
        <StatusDot color={color} isPulsing={isPulsing} size={6} style={{ marginRight: 4 }} />
        <Text numberOfLines={1} ellipsizeMode="tail" style={[styles.statusText, large && styles.tabletStatusText, { color }]}>{text}</Text>
    </View>
));

export const HomeHeaderMark = React.memo(() => {
    const compact = useWindowDimensions().width < 330;
    return (
        <MobileGlassSurface nativeEffect style={[styles.glass, compact && styles.glassCompact]}>
            <View style={styles.content}>
                <HeaderLogo />
            </View>
        </MobileGlassSurface>
    );
});
