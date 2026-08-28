import 'react-native-quick-base64';
import '../theme.css';
import * as React from 'react';
import * as SplashScreen from 'expo-splash-screen';
import * as Fonts from 'expo-font';
import * as Notifications from 'expo-notifications';
import * as Updates from 'expo-updates';
import { FontAwesome } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { AuthCredentials, TokenStorage } from '@/account';
import { AuthProvider } from '@/account/ui';
import { restoreHostedConnection } from '@/pairing/e2ee';
import { resetWebSecureStore } from '@/pairing/secrets';
import { RelayDiscoveryReconnect } from '@/pairing';
import { DarkTheme, DefaultTheme, ThemeProvider } from '@react-navigation/native';
import { KeyboardProvider } from 'react-native-keyboard-controller';
import { initialWindowMetrics, SafeAreaProvider, useSafeAreaInsets } from 'react-native-safe-area-context';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { PluginSlot } from '@/plugins/ui';
import { usePluginEvents } from '@/plugins';
import { SidebarNavigator } from '@/herd/ui';
import sodium from '@/encryption/libsodium.lib';
import { View, Platform, AppState, Pressable, Text } from 'react-native';
import { ModalProvider } from '@/modal';
import { syncReconnect, syncRestore } from '@/catalog/sync';
import { FaviconPermissionIndicator } from '@/components/web/FaviconPermissionIndicator';
import { CommandPaletteProvider } from '@/components/CommandPalette/CommandPaletteProvider';
import { StatusBarProvider } from '@/components/StatusBarProvider';
// import * as SystemUI from 'expo-system-ui';
import { initConsoleLogging, setConsoleOutputEnabled } from '@/utils/consoleLogging';
import { useLocalSetting } from '@/catalog/store';
import { useUnistyles } from 'react-native-unistyles';
import { AsyncLock } from '@/utils/lock';
import { watchAgentLifecycle } from '@/herd';
import { navigateToSession } from '@/herd';
import { useTauriZoom } from '@/hooks/useTauriZoom';
import { useTauriDrag } from '@/hooks/useTauriDrag';
import { BrowserNavigationShortcuts } from '@/hooks/useBrowserNavigationShortcuts';
import { KernelNotifications } from '@/herd/ui';
import { acknowledgeLifecyclePush } from '@/utils/nativePushNotifications';

// Configure notification handler — suppress push display when app is in foreground
Notifications.setNotificationHandler({
    handleNotification: async () => {
        const isForeground = AppState.currentState === 'active';
        return {
            shouldShowAlert: !isForeground,
            shouldPlaySound: !isForeground,
            shouldSetBadge: true,
            shouldShowBanner: !isForeground,
            shouldShowList: true,
        };
    },
});

// Setup Android notification channels (required for Android 8.0+)
if (Platform.OS === 'android') {
    Notifications.setNotificationChannelAsync('default', {
        name: 'Default',
        importance: Notifications.AndroidImportance.MAX,
        vibrationPattern: [0, 250, 250, 250],
        lightColor: '#FF231F7C',
    });
    Notifications.setNotificationChannelAsync('messages', {
        name: 'Messages',
        importance: Notifications.AndroidImportance.HIGH,
        vibrationPattern: [0, 250, 250, 250],
        lightColor: '#FF231F7C',
    });
}

export {
    // Catch any errors thrown by the Layout component.
    ErrorBoundary,
} from 'expo-router';

// Configure splash screen
SplashScreen.setOptions({
    fade: true,
    duration: 300,
})
SplashScreen.preventAutoHideAsync();

// Set window background color - now handled by Unistyles
// SystemUI.setBackgroundColorAsync('white');

// Remote logging to local log server (configured via Dev > Log Server setting)
initConsoleLogging()

// Component to apply horizontal safe area padding
/** Kernel side of manifest-declared triggers; owns no feature behaviour. */
function PluginEventRunner() {
    usePluginEvents();
    return null;
}

function HorizontalSafeAreaWrapper({ children }: { children: React.ReactNode }) {
    const insets = useSafeAreaInsets();
    return (
        <View style={{
            flex: 1,
            paddingLeft: insets.left,
            paddingRight: insets.right
        }}>
            {children}
        </View>
    );
}

let lock = new AsyncLock();
let loaded = false;

async function loadFonts() {
    await lock.inLock(async () => {
        if (loaded) {
            return;
        }
        loaded = true;
        // Check if running in Tauri
        const isTauri = Platform.OS === 'web' &&
            typeof window !== 'undefined' &&
            (window as any).__TAURI_INTERNALS__ !== undefined;

        if (!isTauri) {
            // Normal font loading for non-Tauri environments (native and regular web)
            await Fonts.loadAsync({
                // IBM Plex Sans family
                'IBMPlexSans-Regular': require('@/assets/fonts/IBMPlexSans-Regular.ttf'),
                'IBMPlexSans-Italic': require('@/assets/fonts/IBMPlexSans-Italic.ttf'),
                'IBMPlexSans-SemiBold': require('@/assets/fonts/IBMPlexSans-SemiBold.ttf'),

                // IBM Plex Mono family
                'IBMPlexMono-Regular': require('@/assets/fonts/IBMPlexMono-Regular.ttf'),
                'IBMPlexMono-Italic': require('@/assets/fonts/IBMPlexMono-Italic.ttf'),
                'IBMPlexMono-SemiBold': require('@/assets/fonts/IBMPlexMono-SemiBold.ttf'),

                // Bricolage Grotesque
                'BricolageGrotesque-Bold': require('@/assets/fonts/BricolageGrotesque-Bold.ttf'),

                ...FontAwesome.font,
            });
        } else {
            // For Tauri, skip Font Face Observer as fonts are loaded via CSS
            console.log('Do not wait for fonts to load');
            (async () => {
                try {
                    await Fonts.loadAsync({
                        // IBM Plex Sans family
                        'IBMPlexSans-Regular': require('@/assets/fonts/IBMPlexSans-Regular.ttf'),
                        'IBMPlexSans-Italic': require('@/assets/fonts/IBMPlexSans-Italic.ttf'),
                        'IBMPlexSans-SemiBold': require('@/assets/fonts/IBMPlexSans-SemiBold.ttf'),

                        // IBM Plex Mono family
                        'IBMPlexMono-Regular': require('@/assets/fonts/IBMPlexMono-Regular.ttf'),
                        'IBMPlexMono-Italic': require('@/assets/fonts/IBMPlexMono-Italic.ttf'),
                        'IBMPlexMono-SemiBold': require('@/assets/fonts/IBMPlexMono-SemiBold.ttf'),

                        // Bricolage Grotesque
                        'BricolageGrotesque-Bold': require('@/assets/fonts/BricolageGrotesque-Bold.ttf'),

                        ...FontAwesome.font,
                    });
                } catch (e) {
                    // Ignore
                }
            })();
        }
    });
}

function getDevEnvironmentCredentials(): AuthCredentials | null {
    if (!__DEV__) {
        return null;
    }

    const token = process.env.EXPO_PUBLIC_DEV_TOKEN;
    const secret = process.env.EXPO_PUBLIC_DEV_SECRET;
    if (!token || !secret) {
        return null;
    }

    return { token, secret };
}

function getDevWebQueryCredentials(): AuthCredentials | null {
    if (!__DEV__ || Platform.OS !== 'web' || typeof window === 'undefined') {
        return null;
    }

    const params = new URLSearchParams(window.location.search);
    const token = params.get('dev_token');
    const secret = params.get('dev_secret');
    if (!token || !secret) {
        return null;
    }

    return { token, secret };
}

export default function RootLayout() {
    useTauriZoom();
    useTauriDrag();
    const router = useRouter();
    const { theme } = useUnistyles();
    const navigationTheme = React.useMemo(() => {
        if (theme.dark) {
            return {
                ...DarkTheme,
                colors: {
                    ...DarkTheme.colors,
                    background: theme.colors.groupped.background,
                }
            }
        }
        return {
            ...DefaultTheme,
            colors: {
                ...DefaultTheme.colors,
                background: theme.colors.groupped.background,
            }
        };
    }, [theme.dark]);

    //
    // Init sequence
    //
    const [initState, setInitState] = React.useState<{ credentials: AuthCredentials | null; error?: string } | null>(null);

    React.useEffect(() => {
        const subscription = Notifications.addNotificationReceivedListener((notification) => {
            acknowledgeLifecyclePush(notification.request.content.data);
        });
        return () => subscription.remove();
    }, []);
    React.useEffect(() => {
        (async () => {
            let credentials: AuthCredentials | null = null;
            try {
                await loadFonts();
                await sodium.ready;
                // Skia draws the gauge and ring charts. Native ships it in the
                // binary; the browser has to fetch CanvasKit first, and without
                // this every plugin panel holding one of those charts died on
                // `CanvasKit is not defined`.
                if (Platform.OS === 'web') {
                    const { LoadSkiaWeb } = await import('@shopify/react-native-skia/lib/module/web');
                    await LoadSkiaWeb({ locateFile: (file: string) => `/${file}` });
                }

                try {
                    credentials = await TokenStorage.getCredentials();
                    const restoredGrant = await restoreHostedConnection();
                    if (restoredGrant !== undefined && (credentials?.token !== restoredGrant.credential
                        || credentials?.secret !== restoredGrant.deviceKey.secretKey)) {
                        credentials = { token: restoredGrant.credential, secret: restoredGrant.deviceKey.secretKey };
                        await TokenStorage.setCredentials(credentials);
                    }
                } catch (error) {
                    setInitState({
                        credentials,
                        error: error instanceof Error ? error.message : String(error),
                    });
                    return;
                }
                const devCredentials = getDevWebQueryCredentials() ?? getDevEnvironmentCredentials();

                if (devCredentials) {
                    const credentialsChanged = credentials?.token !== devCredentials.token
                        || credentials?.secret !== devCredentials.secret;

                    if (credentialsChanged) {
                        const saved = await TokenStorage.setCredentials(devCredentials);
                        if (saved) {
                            credentials = devCredentials;
                        }
                    }

                    if (Platform.OS === 'web' && typeof window !== 'undefined') {
                        window.history.replaceState({}, '', window.location.pathname);
                    }
                }

                if (credentials) {
                    try {
                        if (Platform.OS !== 'web') {
                            const presented = await Notifications.getPresentedNotificationsAsync().catch(() => []);
                            for (const notification of presented) {
                                acknowledgeLifecyclePush(notification.request.content.data);
                            }
                        }
                        await syncRestore(credentials);
                    } catch (error) {
                        // Machine/grant/network/bootstrap failures are not account rejection.
                        // Runtime /v1/session validation clears only a definite 401.
                        console.error('Error restoring sync:', error);
                    }
                }

                setInitState({ credentials });
            } catch (error) {
                // Font/Skia/sync bootstrap failures are not evidence that the
                // encrypted pairing store is corrupt and must never offer reset.
                console.error('Error initializing:', error);
                setInitState({ credentials });
            }
        })();
    }, []);

    React.useEffect(() => {
        if (initState) {
            setTimeout(() => {
                SplashScreen.hideAsync();
            }, 100);
        }
    }, [initState]);

    React.useEffect(() => {
        if (initState?.credentials === undefined || Platform.OS === 'web') return;
        let previous = AppState.currentState;
        const subscription = AppState.addEventListener('change', (next) => {
            const resumed = next === 'active' && previous !== 'active';
            previous = next;
            if (resumed) void syncReconnect().catch(() => undefined);
        });
        return () => subscription.remove();
    }, [initState?.credentials]);

    const handledNotificationIds = React.useRef<Set<string>>(new Set());
    const handleNotificationResponse = React.useCallback(async (response: Notifications.NotificationResponse | null) => {
        if (!response) {
            console.log('[PUSH ROUTING] Notification response is null');
            return;
        }

        const responseId = response.notification.request.identifier;
        if (handledNotificationIds.current.has(responseId)) {
            console.log(`[PUSH ROUTING] Duplicate notification response ignored: ${responseId}`);
            return;
        }

        handledNotificationIds.current.add(responseId);
        acknowledgeLifecyclePush(response.notification.request.content.data);

        try {
            if (response.actionIdentifier !== Notifications.DEFAULT_ACTION_IDENTIFIER) {
                console.log(`[PUSH ROUTING] Ignoring non-default action: ${response.actionIdentifier}`);
                return;
            }

            const watched = watchAgentLifecycle({ notification: response });
            console.log(`[PUSH ROUTING] Computed route: ${watched.agentRoute ?? 'null'}`);
            if (!watched.agentRoute) {
                console.log('[PUSH ROUTING] No session route found in notification.request.content.data');
                return;
            }

            console.log(`[PUSH ROUTING] Navigating to session: ${watched.agentRoute}`);
            navigateToSession(router, watched.agentRoute);
        } finally {
            try {
                await Notifications.clearLastNotificationResponseAsync();
            } catch (error) {
                console.log('Failed to clear last notification response:', error);
            }
        }
    }, [router]);

    React.useEffect(() => {
        if (!initState) {
            return;
        }

        let active = true;
        const subscription = Notifications.addNotificationResponseReceivedListener((response) => {
            void handleNotificationResponse(response);
        });

        void (async () => {
            try {
                const response = await Notifications.getLastNotificationResponseAsync();
                if (active) {
                    await handleNotificationResponse(response);
                }
            } catch (error) {
                console.log('Failed to read last notification response:', error);
            }
        })();

        return () => {
            active = false;
            subscription.remove();
        };
    }, [handleNotificationResponse, initState]);



    // Sync console output toggle from Dev screen
    const consoleLoggingEnabled = useLocalSetting('consoleLoggingEnabled');
    React.useEffect(() => {
        setConsoleOutputEnabled(consoleLoggingEnabled);
    }, [consoleLoggingEnabled]);

    //
    // Not inited
    //

    if (!initState) {
        return null;
    }
    if (initState.error !== undefined) {
        return (
            <SafeAreaProvider initialMetrics={initialWindowMetrics}>
                <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', gap: 16, padding: 24, backgroundColor: theme.colors.groupped.background }}>
                    <Text accessibilityRole="header" style={{ color: theme.colors.text, fontSize: 22, fontWeight: '700' }}>muxr could not start safely</Text>
                    <Text accessibilityRole="alert" style={{ color: theme.colors.textSecondary, textAlign: 'center', maxWidth: 480 }}>
                        {Platform.OS === 'web'
                            ? 'muxr could not restore this browser safely. Nothing was silently reset. Retry first; reset local pairing storage only if recovery keeps failing.'
                            : 'muxr could not restore this device safely. Nothing was silently reset. Retry before pairing again.'}
                    </Text>
                    <Text style={{ color: theme.colors.textSecondary, textAlign: 'center', maxWidth: 480 }}>{initState.error}</Text>
                    <Pressable accessibilityRole="button" onPress={() => {
                        if (Platform.OS === 'web') window.location.reload();
                        else void Updates.reloadAsync();
                    }} style={{ paddingHorizontal: 20, paddingVertical: 12, borderRadius: 10, backgroundColor: theme.colors.button.primary.background }}>
                        <Text style={{ color: theme.colors.button.primary.tint, fontWeight: '700' }}>Retry restore</Text>
                    </Pressable>
                    {Platform.OS === 'web' && <>
                        <Pressable accessibilityRole="button" onPress={() => {
                            if (!window.confirm('Reset this browser? Its local muxr pairings will be permanently removed.')) return;
                            void resetWebSecureStore().then(() => window.location.reload());
                        }} style={{ paddingHorizontal: 20, paddingVertical: 12 }}>
                            <Text style={{ color: theme.colors.deleteAction }}>Reset this browser</Text>
                        </Pressable>
                    </>}
                </View>
            </SafeAreaProvider>
        );
    }

    //
    // Boot
    //

    let providers = (
        <SafeAreaProvider initialMetrics={initialWindowMetrics}>
            <KeyboardProvider preload={false}>
                <GestureHandlerRootView
                    style={Platform.OS === 'web'
                        ? { flex: 1 }
                        : { flex: 1, backgroundColor: theme.colors.groupped.background }}
                >
                    <AuthProvider initialCredentials={initState.credentials}>
                        <RelayDiscoveryReconnect />
                        <KernelNotifications />
                        <ThemeProvider value={navigationTheme}>
                            <StatusBarProvider />
                            <ModalProvider>
                                <BrowserNavigationShortcuts />
                                <CommandPaletteProvider>
                                        <HorizontalSafeAreaWrapper>
                                            {/* Keep the root conversation mounted while routes change. */}
                                            <SidebarNavigator />
                                        </HorizontalSafeAreaWrapper>
                                        <PluginEventRunner />
                                        <PluginSlot slot="app.overlay" context={{}} />
                                </CommandPaletteProvider>
                            </ModalProvider>
                        </ThemeProvider>
                    </AuthProvider>
                </GestureHandlerRootView>
            </KeyboardProvider>
        </SafeAreaProvider>
    );

    return (
        <>
            <FaviconPermissionIndicator />
            {providers}
        </>
    );
}
