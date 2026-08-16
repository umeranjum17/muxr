import * as React from 'react';
import { Pressable, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Image } from 'expo-image';
import { t } from '@/text';
import { Typography } from '@/constants/Typography';
import { layout } from '@/components/layout';

export type TabType = 'plugin' | 'sessions' | 'settings';

interface TabBarProps {
    activeTab: TabType;
    onTabPress: (tab: TabType) => void;
    children?: React.ReactNode;
}

type TabDefinition = {
    key: TabType;
    icon: number;
    label: string;
};

const styles = StyleSheet.create((theme) => ({
    webOuterContainer: {
        backgroundColor: theme.colors.surface,
        borderTopWidth: 1,
        borderTopColor: theme.colors.divider,
    },
    webInnerContainer: {
        flexDirection: 'row',
        justifyContent: 'space-around',
        alignItems: 'flex-start',
        maxWidth: layout.maxWidth,
        width: '100%',
        alignSelf: 'center',
    },
    webTab: {
        flex: 1,
        alignItems: 'center',
        paddingTop: 8,
        paddingBottom: 4,
    },
    webTabContent: {
        alignItems: 'center',
        position: 'relative',
    },
    webLabel: {
        fontSize: 10,
        marginTop: 3,
        ...Typography.default(),
    },
    webBadge: {
        position: 'absolute',
        top: -4,
        right: -8,
        backgroundColor: theme.colors.status.error,
        borderRadius: 8,
        minWidth: 16,
        height: 16,
        paddingHorizontal: 4,
        justifyContent: 'center',
        alignItems: 'center',
    },
    webIndicatorDot: {
        position: 'absolute',
        top: 0,
        right: -2,
        width: 6,
        height: 6,
        borderRadius: 3,
        backgroundColor: theme.colors.text,
    },
    labelActive: {
        color: theme.dark ? '#FFFFFF' : theme.colors.text,
        ...Typography.default('semiBold'),
    },
    labelInactive: {
        color: theme.dark ? 'rgba(255,255,255,0.58)' : theme.colors.textSecondary,
    },
    badgeText: {
        color: '#FFFFFF',
        fontSize: 10,
        ...Typography.default('semiBold'),
    },
}));

// Rendered on web only (see MainView); native navigation lives in HomeDock.
export const TabBar = React.memo(({ activeTab, onTabPress, children }: TabBarProps) => {
    const { theme } = useUnistyles();
    const insets = useSafeAreaInsets();
    const tabs: TabDefinition[] = React.useMemo(() => [
        { key: 'sessions', icon: require('@/assets/images/brutalist/Brutalism-15.png'), label: t('tabs.sessions') },
        { key: 'settings', icon: require('@/assets/images/brutalist/Brutalism-9.png'), label: t('tabs.settings') },
    ], []);

    return (
        <View style={[styles.webOuterContainer, { paddingBottom: insets.bottom }]}>
            <View style={styles.webInnerContainer}>
                {children}
                {tabs.map((tab) => {
                    const isActive = activeTab === tab.key;
                    return (
                        <Pressable
                            key={tab.key}
                            style={styles.webTab}
                            onPress={() => onTabPress(tab.key)}
                            hitSlop={8}
                        >
                            <View style={styles.webTabContent}>
                                <Image
                                    source={tab.icon}
                                    contentFit="contain"
                                    style={{ width: 24, height: 24 }}
                                    tintColor={isActive ? theme.colors.text : theme.colors.textSecondary}
                                />
                            </View>
                            <Text style={[styles.webLabel, isActive ? styles.labelActive : styles.labelInactive]}>
                                {tab.label}
                            </Text>
                        </Pressable>
                    );
                })}
            </View>
        </View>
    );
});
