import * as React from 'react';
import { View, ScrollView, ActivityIndicator, Pressable, Platform } from 'react-native';
import { WebView } from 'react-native-webview';
import { useUnistyles } from 'react-native-unistyles';
import { Ionicons } from '@expo/vector-icons';
import { useLocalSearchParams } from 'expo-router';
import type { PreviewServer } from '@muxr/contract';
import { Text } from '@/components/StyledText';
import { Typography } from '@/constants/Typography';
import { sync } from '@/sync/sync';
import { useSession, useSocketStatus } from '@/sync/storage';
import { openPreview, type OpenPreview } from '@/preview/openPreview';

function describe(server: PreviewServer): string {
    return server.command === '' ? 'HTTP server' : server.command;
}

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
    const [servers, setServers] = React.useState<PreviewServer[] | null>(null);
    const [error, setError] = React.useState<string | null>(null);
    const [opening, setOpening] = React.useState<number | null>(null);
    const [preview, setPreview] = React.useState<OpenPreview | null>(null);
    const { status } = useSocketStatus();

    const refresh = React.useCallback(() => {
        setError(null);
        setServers(null);
        const path = session?.metadata?.path;
        sync.request('preview.list', path === undefined ? {} : { cwd: path })
            .then(setServers)
            .catch((cause: unknown) => {
                setError(cause instanceof Error ? cause.message : String(cause));
                setServers([]);
            });
    }, [session?.metadata?.path]);

    React.useEffect(() => {
        if (status !== 'connected' || session === undefined) return;
        if (directPort !== undefined) {
            setServers(webNeedsTab ? [{ port: directPort, bind: '127.0.0.1', command: '' }] : []);
            return;
        }
        refresh();
    }, [directPort, refresh, session, status]);

    React.useEffect(() => () => preview?.close(), [preview]);

    const choose = React.useCallback(async (selected: number): Promise<boolean> => {
        setOpening(selected);
        setError(null);
        const tab = webNeedsTab ? window.open('about:blank', '_blank') : null;
        try {
            const opened = await openPreview(selected);
            if (tab !== null) tab.location.href = opened.url;
            setPreview(opened);
            return true;
        } catch (cause: unknown) {
            tab?.close();
            setError(cause instanceof Error ? cause.message : String(cause));
            return false;
        } finally {
            setOpening(null);
        }
    }, []);

    const directAttempt = React.useRef<string | undefined>(undefined);
    React.useEffect(() => {
        if (directPort === undefined || webNeedsTab || status !== 'connected' || session === undefined || preview !== null) return;
        const key = `${id}:${directPort}`;
        if (directAttempt.current === key) return;
        directAttempt.current = key;
        void choose(directPort);
    }, [choose, directPort, id, preview, refresh, session, status]);

    const autoOpened = React.useRef(false);
    React.useEffect(() => {
        if (directPort !== undefined || autoOpened.current || webNeedsTab || servers?.length !== 1 || preview !== null) return;
        autoOpened.current = true;
        void choose(servers[0].port);
    }, [choose, directPort, preview, servers]);

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
        <ScrollView style={{ flex: 1, backgroundColor: theme.colors.groupped.background }} contentContainerStyle={{ padding: 16 }}>
            {error !== null && <Text style={{ ...Typography.default(), color: theme.colors.textDestructive, marginBottom: 12 }}>{error}</Text>}
            {error !== null && directPort !== undefined && !webNeedsTab && opening === null && (
                <Pressable onPress={() => void choose(directPort)} accessibilityRole="button" accessibilityLabel="Retry preview" style={{ paddingVertical: 14, alignItems: 'center' }}>
                    <Text style={{ ...Typography.default('semiBold'), color: theme.colors.textLink }}>Retry</Text>
                </Pressable>
            )}

            {(servers === null || status !== 'connected' || session === undefined) && <ActivityIndicator size="small" color={theme.colors.text} />}

            {directPort === undefined && servers !== null && servers.length === 0 && status === 'connected' && opening === null && (
                <Text style={{ ...Typography.default(), color: theme.colors.textSecondary }}>
                    No dev server found for this project.
                </Text>
            )}

            {servers?.map((server) => (
                <Pressable
                    key={`${server.bind}:${server.port}`}
                    onPress={() => void choose(server.port)}
                    disabled={opening !== null}
                    style={{
                        flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 14, paddingHorizontal: 16,
                        marginBottom: 8, borderRadius: 12, backgroundColor: theme.colors.surface,
                        opacity: opening !== null && opening !== server.port ? 0.4 : 1,
                    }}
                >
                    <Ionicons name="globe-outline" size={20} color={theme.colors.text} />
                    <View style={{ flex: 1 }}>
                        <Text style={{ ...Typography.default('semiBold'), color: theme.colors.text }}>{`localhost:${server.port}`}</Text>
                        <Text style={{ ...Typography.default(), fontSize: 13, color: theme.colors.textSecondary }}>{describe(server)}</Text>
                    </View>
                    {opening === server.port && <ActivityIndicator size="small" color={theme.colors.text} />}
                </Pressable>
            ))}

            {directPort === undefined && <Pressable onPress={refresh} style={{ paddingVertical: 14, alignItems: 'center' }}>
                <Text style={{ ...Typography.default(), color: theme.colors.textLink }}>Refresh</Text>
            </Pressable>}
        </ScrollView>
    );
}
