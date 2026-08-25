import { Stack } from 'expo-router';
import 'react-native-reanimated';
import * as React from 'react';
import { Typography } from '@/constants/Typography';
import { createHeader } from '@/components/navigation/Header';
import { Platform, TouchableOpacity, Text, View } from 'react-native';
import { isRunningOnMac } from '@/utils/platform';
import { useUnistyles } from 'react-native-unistyles';
import { t } from '@/text';
import { MobileGlassBackdrop } from '@/components/MobileGlass';

export const unstable_settings = {
    initialRouteName: 'index',
};

export default function RootLayout() {
    // Keep UIKit in charge of iPhone/iPad headers. A custom React header makes
    // native-stack animate every blur/glass subview during each push and pop.
    const shouldUseCustomHeader = Platform.OS === 'android' || isRunningOnMac() || Platform.OS === 'web';
    const isDesktop = Platform.OS === 'web' || isRunningOnMac();
    const { theme } = useUnistyles();

    return (
        <View
            style={{
                flex: 1,
                backgroundColor: isDesktop
                    ? theme.colors.surface
                    : theme.colors.groupped.background,
            }}
        >
            <MobileGlassBackdrop enabled={!isDesktop} />
        <Stack
            initialRouteName='index'
            screenOptions={{
                header: shouldUseCustomHeader ? createHeader : undefined,
                headerBackTitle: t('common.back'),
                headerBackButtonDisplayMode: Platform.OS === 'ios' ? 'minimal' : undefined,
                headerShadowVisible: false,
                contentStyle: {
                    backgroundColor: isDesktop
                        ? theme.colors.surface
                        : theme.colors.groupped.background,
                },
                headerStyle: {
                    backgroundColor: isDesktop ? theme.colors.header.background : 'transparent',
                },
                headerTintColor: theme.colors.header.tint,
                headerTitleStyle: {
                    color: theme.colors.header.tint,
                    ...Typography.default('semiBold'),
                },

            }}
        >
            <Stack.Screen
                name="index"
                options={{
                    headerShown: false,
                    headerTitle: ''
                }}
            />
            <Stack.Screen
                name="new-agent"
                options={{
                    headerShown: false,
                }}
            />
            <Stack.Screen
                name="shortcut/[id]"
                options={{
                    headerShown: false,
                    headerTitle: '',
                }}
            />
            <Stack.Screen
                name="plugin/index"
                options={{
                    headerShown: false,
                    headerTitle: '',
                    headerBackTitle: t('common.home')
                }}
            />
            <Stack.Screen
                name="settings/index"
                options={{
                    headerShown: true,
                    headerTitle: t('settings.title'),
                    headerBackTitle: t('common.home')
                }}
            />
            <Stack.Screen
                name="session/[id]"
                options={{
                    headerShown: false
                }}
            />
            <Stack.Screen
                name="grid/[tabId]"
                options={{
                    headerShown: false
                }}
            />
                                                                        <Stack.Screen
                name="session/[id]/preview"
                options={{
                    headerShown: true,
                    headerTitle: t('navigation.browserPreview'),
                    headerBackTitle: t('common.back'),
                }}
            />
            <Stack.Screen
                name="session/[id]/takeover"
                options={{
                    headerShown: true,
                    headerTitle: t('navigation.browserTakeover'),
                    headerBackTitle: t('common.back'),
                }}
            />
            <Stack.Screen
                name="settings/appearance"
                options={{
                    headerTitle: t('settings.appearance'),
                }}
            />
            <Stack.Screen
                name="settings/features"
                options={{
                    headerTitle: t('settings.features'),
                }}
            />
            <Stack.Screen
                name="settings/plugins"
                options={{
                    headerTitle: t('plugins.settingsTitle'),
                }}
            />
            <Stack.Screen
                name="settings/voice"
                options={{
                    headerTitle: 'Realtime voice',
                }}
            />
            <Stack.Screen
                name="restore/index"
                options={{
                    headerShown: true,
                    headerTitle: t('navigation.linkNewDevice'),
                    headerBackTitle: t('common.back'),
                }}
            />
            <Stack.Screen
                name="restore/manual"
                options={{
                    headerShown: true,
                    headerTitle: t('navigation.restoreWithSecretKey'),
                    headerBackTitle: t('common.back'),
                }}
            />
            <Stack.Screen
                name="changelog"
                options={{
                    headerShown: true,
                    headerTitle: t('navigation.whatsNew'),
                    headerBackTitle: t('common.back'),
                }}
            />
            <Stack.Screen
                name="text-selection"
                options={{
                    headerShown: true,
                    headerTitle: t('textSelection.title'),
                    headerBackTitle: t('common.back'),
                }}
            />
            <Stack.Screen
                name="user/[id]"
                options={{
                    headerShown: true,
                    headerTitle: '',
                    headerBackTitle: t('common.back'),
                }}
            />
            <Stack.Screen
                name="session/recent"
                options={{
                    headerShown: true,
                    headerTitle: t('sessionHistory.title'),
                    headerBackTitle: t('common.back'),
                }}
            />
        </Stack>
        </View>
    );
}
