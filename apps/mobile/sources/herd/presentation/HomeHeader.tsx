import * as React from 'react';
import { Image } from 'expo-image';
import { Header } from '@/components/navigation/Header';
import { useSocketStatus } from '@/sync/storage';
import { Platform, Text, View } from 'react-native';
import { Typography } from '@/constants/Typography';
import { StatusDot } from '@/components/StatusDot';
import { useSegments } from 'expo-router';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { t } from '@/text';

const stylesheet = StyleSheet.create((theme, runtime) => ({
    logoContainer: {
        // marginHorizontal: 4,
        width: 32,
        height: 32,
        alignItems: 'center',
        justifyContent: 'center',
        tintColor: theme.colors.header.tint,
    },
    titleContainer: {
        flex: 1,
        alignItems: 'center',
    },
    titleText: {
        fontSize: 17,
        color: theme.colors.header.tint,
        fontWeight: '600',
        ...Typography.default('semiBold'),
    },
    statusContainer: {
        flexDirection: 'row',
        alignItems: 'center',
        marginTop: -2,
    },
    statusDot: {
        marginRight: 4,
    },
    statusText: {
        fontSize: 12,
        fontWeight: '500',
        lineHeight: 16,
        ...Typography.default(),
    },
    // Status colors
    statusConnected: {
        color: theme.colors.status.connected,
    },
    statusConnecting: {
        color: theme.colors.status.connecting,
    },
    statusDisconnected: {
        color: theme.colors.status.disconnected,
    },
    statusError: {
        color: theme.colors.status.error,
    },
    statusDefault: {
        color: theme.colors.status.default,
    },
    centeredTitle: {
        textAlign: Platform.OS === 'ios' ? 'center' : 'left',
        alignSelf: Platform.OS === 'ios' ? 'center' : 'flex-start',
        flex: 1,
    },
}));


export const HomeHeaderNotAuth = React.memo(() => {
    useSegments(); // Re-rendered automatically when screen navigates back
    const { theme } = useUnistyles();
    return (
        <Header
            title={<HeaderTitleWithSubtitle />}
            headerLeft={() => <HeaderLeft />}
            headerLeftGlass={Platform.OS !== 'web'}
            headerShadowVisible={false}
            headerBackgroundColor={theme.colors.groupped.background}
        />
    )
});

function HeaderLeft() {
    const styles = stylesheet;
    const { theme } = useUnistyles();
    return (
        <View style={styles.logoContainer}>
            <Image
                source={require('@/assets/images/glyph.png')}
                contentFit="contain"
                tintColor={theme.colors.header.tint}
                style={{ width: 24, height: 16 }}
            />
        </View>
    );
}

function HeaderTitleWithSubtitle() {
    const socketStatus = useSocketStatus();
    const styles = stylesheet;

    // Get connection status styling (matching sessionUtils.ts pattern)
    const getConnectionStatus = () => {
        const { status } = socketStatus;
        switch (status) {
            case 'connected':
                return {
                    color: styles.statusConnected.color,
                    isPulsing: false,
                    text: t('status.connected'),
                    textColor: styles.statusConnected.color
                };
            case 'connecting':
                return {
                    color: styles.statusConnecting.color,
                    isPulsing: true,
                    text: t('status.connecting'),
                    textColor: styles.statusConnecting.color
                };
            case 'disconnected':
                return {
                    color: styles.statusDisconnected.color,
                    isPulsing: false,
                    text: t('status.disconnected'),
                    textColor: styles.statusDisconnected.color
                };
            case 'error':
                return {
                    color: styles.statusError.color,
                    isPulsing: false,
                    // socketError is only ever a permanent pairing failure
                    // (revoked/expired grant) — the nav header gets the short
                    // label, connection.tsx shows the full sentence.
                    text: socketStatus.error !== null ? t('status.pairingIssue') : t('status.error'),
                    textColor: styles.statusError.color
                };
            default:
                return {
                    color: styles.statusDefault.color,
                    isPulsing: false,
                    text: '',
                    textColor: styles.statusDefault.color
                };
        }
    };

    const connectionStatus = getConnectionStatus();
    const showConnectionStatus = connectionStatus.text;

    return (
        <View style={styles.titleContainer}>
            <Text style={styles.titleText}>
                {t('sidebar.sessionsTitle')}
            </Text>
            {showConnectionStatus && (
                <View style={styles.statusContainer}>
                    <StatusDot
                        color={connectionStatus.color}
                        isPulsing={connectionStatus.isPulsing}
                        size={6}
                        style={styles.statusDot}
                    />
                    <Text numberOfLines={1} style={[
                        styles.statusText,
                        { color: connectionStatus.textColor }
                    ]}>
                        {connectionStatus.text}
                    </Text>
                </View>
            )}
        </View>
    );
}
