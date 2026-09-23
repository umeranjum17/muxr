import * as React from 'react';
import { Pressable, View, useWindowDimensions } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { HeaderLogo } from '@/components/HeaderLogo';
import { MobileGlassSurface } from '@/components/MobileGlass';
import { t } from '@/text';

const styles = StyleSheet.create(() => ({
    actions: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 4,
    },
    actionsCompact: { gap: 0 },
    target: {
        width: 44,
        height: 44,
        alignItems: 'center',
        justifyContent: 'center',
    },
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

    return (
        <View style={[styles.actions, compact && styles.actionsCompact]}>
            <Pressable
                onPress={() => router.push('/panes')}
                style={styles.target}
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
                style={styles.target}
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
                style={styles.target}
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
