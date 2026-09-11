import * as React from 'react';
import { View, ActivityIndicator, Pressable, Platform } from 'react-native';
import { WebView } from 'react-native-webview';
import { useUnistyles } from 'react-native-unistyles';
import { Ionicons } from '@expo/vector-icons';
import { useLocalSearchParams } from 'expo-router';
import { Text } from '@/components/StyledText';
import { Typography } from '@/constants/Typography';
import { useSession, useSocketStatus } from '@/catalog/store';
import * as Device from 'expo-device';
import { openPreview, type OpenPreview } from '@/preview';
import { humanError } from '@/utils/errors';

function selectedPort(value: string | undefined): number | undefined {
    if (value === undefined || !/^\d{1,5}$/.test(value)) return undefined;
    const port = Number(value);
    return Number.isSafeInteger(port) && port >= 1 && port <= 65_535 ? port : undefined;
}

/**
 * An https page cannot frame an http preview, so a legacy relay-port preview
 * keeps a real tap on TLS web. The service-worker bridge serves same-origin
 * over TLS and frames inline -- native and non-TLS web open directly too.
 */
const pageIsHttps = Platform.OS === 'web' && typeof window !== 'undefined' && window.location.protocol === 'https:';

function previewUrlNeedsTab(url: string): boolean {
    if (!pageIsHttps) return false;
    try {
        return new URL(url, window.location.href).protocol === 'http:';
    } catch {
        return true;
    }
}

/**
 * A same-origin preview runs page JS in the PWA's origin, where the device
 * credential lives -- sandbox it away from storage, cookies, and top
 * navigation. Cross-origin (relay-port) previews are isolated already.
 * Cost: app-JS fetch/XHR under the opaque origin needs the app to allow it,
 * and HMR sockets cannot ride the request bridge.
 */
const PREVIEW_SANDBOX = 'allow-scripts allow-forms allow-modals allow-popups allow-downloads';

function previewUrlIsSandboxed(url: string): boolean {
    if (Platform.OS !== 'web' || typeof window === 'undefined') return false;
    try {
        return new URL(url, window.location.href).origin === window.location.origin;
    } catch {
        return false;
    }
}

export default function PreviewScreen() {
    const { theme } = useUnistyles();
    const { id, port } = useLocalSearchParams<{ id: string; port?: string }>();
    const directPort = selectedPort(port);
    const session = useSession(id);
    const [error, setError] = React.useState<string | null>(null);
    const [opening, setOpening] = React.useState(false);
    const [preview, setPreview] = React.useState<OpenPreview | null>(null);
    const { status } = useSocketStatus();

    React.useEffect(() => () => preview?.close(), [preview]);

    const choose = React.useCallback(async (selected: number): Promise<void> => {
        setOpening(true);
        setError(null);
        // Popup blockers need the gesture: open tentatively on TLS web, where
        // a legacy relay-port preview cannot be framed. The service-worker
        // bridge frames inline, so an unused tab is closed again below.
        const tab = pageIsHttps ? window.open('about:blank', '_blank') : null;
        try {
            const opened = await openPreview({
                port: selected,
                onIosSimulator: Platform.OS === 'ios' && Device.isDevice === false,
            });
            if (previewUrlNeedsTab(opened.url)) {
                if (tab !== null) tab.location.href = opened.url;
                else window.open(opened.url, '_blank');
            } else {
                tab?.close();
            }
            setPreview(opened);
        } catch (cause: unknown) {
            tab?.close();
            setError(humanError(cause).message);
        } finally {
            setOpening(false);
        }
    }, []);

    const directAttempt = React.useRef<string | undefined>(undefined);
    React.useEffect(() => {
        if (directPort === undefined || pageIsHttps || status !== 'connected' || session === undefined || preview !== null) return;
        const key = `${id}:${directPort}`;
        if (directAttempt.current === key) return;
        directAttempt.current = key;
        void choose(directPort);
    }, [choose, directPort, id, preview, session, status]);

    if (preview !== null) {
        if (Platform.OS === 'web') {
            if (previewUrlNeedsTab(preview.url)) {
                return (
                    <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12, backgroundColor: theme.colors.groupped.background }}>
                        <Ionicons name="open-outline" size={32} color={theme.colors.textSecondary} />
                        <Text style={{ ...Typography.default(), color: theme.colors.text }}>Preview opened in a new tab.</Text>
                        <Pressable onPress={() => window.open(preview.url, '_blank')} hitSlop={10}>
                            <Text style={{ ...Typography.default(), color: theme.colors.textLink }}>Open it again</Text>
                        </Pressable>
                    </View>
                );
            }
            return <View style={{ flex: 1 }}><iframe src={preview.url} sandbox={previewUrlIsSandboxed(preview.url) ? PREVIEW_SANDBOX : undefined} style={{ flex: 1, border: 'none' }} title="preview" /></View>;
        }
        return (
            <WebView
                source={{ uri: preview.url }}
                style={{ flex: 1, backgroundColor: theme.colors.groupped.background }}
                originWhitelist={['*']}
                javaScriptEnabled
                domStorageEnabled
                startInLoadingState
            />
        );
    }

    return (
        <View style={{ flex: 1, backgroundColor: theme.colors.groupped.background, padding: 16 }}>
            {error !== null && <Text style={{ ...Typography.default(), color: theme.colors.textDestructive, marginBottom: 12 }}>{error}</Text>}
            {error !== null && directPort !== undefined && !opening && (
                <Pressable onPress={() => void choose(directPort)} accessibilityRole="button" accessibilityLabel="Retry preview" style={{ paddingVertical: 14, alignItems: 'center' }}>
                    <Text style={{ ...Typography.default('semiBold'), color: theme.colors.textLink }}>Retry</Text>
                </Pressable>
            )}

            {(opening || status !== 'connected' || session === undefined) && <ActivityIndicator size="small" color={theme.colors.text} />}

            {directPort === undefined && (
                <Text style={{ ...Typography.default(), color: theme.colors.textSecondary }}>
                    No preview port given. Dev server links in the terminal land here from the Preview chip.
                </Text>
            )}

            {directPort !== undefined && pageIsHttps && !opening && (
                <Pressable
                    onPress={() => void choose(directPort)}
                    accessibilityRole="button"
                    accessibilityLabel={`Open a preview of localhost:${directPort}`}
                    style={{
                        flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 14, paddingHorizontal: 16,
                        marginBottom: 8, borderRadius: 12, backgroundColor: theme.colors.surface,
                    }}
                >
                    <Ionicons name="globe-outline" size={20} color={theme.colors.text} />
                    <View style={{ flex: 1 }}>
                        <Text style={{ ...Typography.default('semiBold'), color: theme.colors.text }}>{`localhost:${directPort}`}</Text>
                        <Text style={{ ...Typography.default(), fontSize: 13, color: theme.colors.textSecondary }}>Open preview</Text>
                    </View>
                </Pressable>
            )}
        </View>
    );
}
