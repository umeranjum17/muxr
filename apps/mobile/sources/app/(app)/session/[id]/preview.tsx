import * as React from 'react';
import { View, ActivityIndicator, Pressable, Platform } from 'react-native';
import { WebView } from 'react-native-webview';
import { useUnistyles } from 'react-native-unistyles';
import { Ionicons } from '@expo/vector-icons';
import { useLocalSearchParams } from 'expo-router';
import { Text } from '@/components/StyledText';
import { Typography } from '@/constants/Typography';
import { useSession, useSocketStatus } from '@/sync/storage';
import * as Device from 'expo-device';
import { openPreview, type OpenPreview } from '@/preview';

function selectedPort(value: string | undefined): number | undefined {
    if (value === undefined || !/^\d{1,5}$/.test(value)) return undefined;
    const port = Number(value);
    return Number.isSafeInteger(port) && port >= 1 && port <= 65_535 ? port : undefined;
}

/**
 * An https page cannot frame an http preview, so the selected server keeps a
 * real tap on TLS web. Native and non-TLS web can open a selected port directly.
 */
const webNeedsTab = Platform.OS === 'web' && typeof window !== 'undefined' && window.location.protocol === 'https:';

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
        const tab = webNeedsTab ? window.open('about:blank', '_blank') : null;
        try {
            const opened = await openPreview({
                port: selected,
                onIosSimulator: Platform.OS === 'ios' && Device.isDevice === false,
            });
            if (tab !== null) tab.location.href = opened.url;
            setPreview(opened);
        } catch (cause: unknown) {
            tab?.close();
            setError(cause instanceof Error ? cause.message : String(cause));
        } finally {
            setOpening(false);
        }
    }, []);

    const directAttempt = React.useRef<string | undefined>(undefined);
    React.useEffect(() => {
        if (directPort === undefined || webNeedsTab || status !== 'connected' || session === undefined || preview !== null) return;
        const key = `${id}:${directPort}`;
        if (directAttempt.current === key) return;
        directAttempt.current = key;
        void choose(directPort);
    }, [choose, directPort, id, preview, session, status]);

    if (preview !== null) {
        if (Platform.OS === 'web') {
            if (webNeedsTab) {
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
            return <View style={{ flex: 1 }}><iframe src={preview.url} style={{ flex: 1, border: 'none' }} title="preview" /></View>;
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
            {error !== null && directPort !== undefined && !webNeedsTab && !opening && (
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

            {directPort !== undefined && webNeedsTab && !opening && (
                <Pressable
                    onPress={() => void choose(directPort)}
                    accessibilityRole="button"
                    accessibilityLabel={`Open localhost:${directPort} in a new tab`}
                    style={{
                        flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 14, paddingHorizontal: 16,
                        marginBottom: 8, borderRadius: 12, backgroundColor: theme.colors.surface,
                    }}
                >
                    <Ionicons name="globe-outline" size={20} color={theme.colors.text} />
                    <View style={{ flex: 1 }}>
                        <Text style={{ ...Typography.default('semiBold'), color: theme.colors.text }}>{`localhost:${directPort}`}</Text>
                        <Text style={{ ...Typography.default(), fontSize: 13, color: theme.colors.textSecondary }}>Open in a new tab</Text>
                    </View>
                </Pressable>
            )}
        </View>
    );
}
