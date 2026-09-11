import * as React from 'react';
import { View, ActivityIndicator, Pressable, Platform, Linking } from 'react-native';
import { WebView } from 'react-native-webview';
import { useUnistyles } from 'react-native-unistyles';
import { Ionicons } from '@expo/vector-icons';
import { useLocalSearchParams } from 'expo-router';
import { Text } from '@/components/StyledText';
import { Typography } from '@/constants/Typography';
import { useSession, useSocketStatus } from '@/catalog/store';
import * as Device from 'expo-device';
import { openPreview, previewIsSameOrigin, previewMayOpenTopLevel, type OpenPreview } from '@/preview';
import { humanError } from '@/utils/errors';

/** A tunnel that never delivers a first paint is a failure with a retry, not a blank frame. */
const FIRST_PAINT_TIMEOUT_MS = 15_000;

/**
 * One quiet line above the page: where it is, and only the controls the
 * transport really has. An iframe cannot be steered (cross-origin history is
 * opaque), so web gets reload and open-in-tab; the native WebView also goes
 * back and forward.
 */
function PreviewBar(props: { label: string; canGoBack?: boolean; canGoForward?: boolean; onBack?: () => void; onForward?: () => void; onReload: () => void; onOpen?: () => void }) {
    const { theme } = useUnistyles();
    const control = (name: React.ComponentProps<typeof Ionicons>['name'], label: string, onPress: (() => void) | undefined, enabled: boolean) => (
        <Pressable onPress={onPress} disabled={!enabled} hitSlop={10} accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ disabled: !enabled }} style={{ width: 32, height: 32, alignItems: 'center', justifyContent: 'center', opacity: enabled ? 1 : 0.35 }}>
            <Ionicons name={name} size={18} color={theme.colors.textSecondary} />
        </Pressable>
    );
    return (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 2, paddingHorizontal: 8, minHeight: 40, backgroundColor: theme.colors.surfaceHigh, borderBottomWidth: 1, borderBottomColor: theme.colors.divider }}>
            {props.onBack !== undefined && control('chevron-back', 'Back', props.onBack, props.canGoBack === true)}
            {props.onForward !== undefined && control('chevron-forward', 'Forward', props.onForward, props.canGoForward === true)}
            <Text numberOfLines={1} style={{ ...Typography.mono(), flex: 1, fontSize: 12, color: theme.colors.textSecondary, paddingHorizontal: 6 }}>{props.label}</Text>
            {control('refresh-outline', 'Reload preview', props.onReload, true)}
            {props.onOpen !== undefined && control('open-outline', 'Open in browser', props.onOpen, true)}
        </View>
    );
}

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
    return previewIsSameOrigin(url, window.location.href);
}

export default function PreviewScreen() {
    const { theme } = useUnistyles();
    const { id, port } = useLocalSearchParams<{ id: string; port?: string }>();
    const directPort = selectedPort(port);
    const session = useSession(id);
    const [error, setError] = React.useState<string | null>(null);
    const [opening, setOpening] = React.useState(false);
    const [preview, setPreview] = React.useState<OpenPreview | null>(null);
    // Reload key and first-paint readiness for the framed page.
    const [generation, setGeneration] = React.useState(0);
    const [painted, setPainted] = React.useState(false);
    const [nav, setNav] = React.useState({ canGoBack: false, canGoForward: false });
    const webViewRef = React.useRef<WebView>(null);
    const { status } = useSocketStatus();
    // Every await in choose() checks this; retry or leaving the screen bumps
    // it and a late tunnel is closed instead of adopted.
    const attemptRef = React.useRef(0);

    React.useEffect(() => () => preview?.close(), [preview]);
    React.useEffect(() => () => { attemptRef.current += 1; }, []);

    const choose = React.useCallback(async (selected: number): Promise<void> => {
        const attempt = ++attemptRef.current;
        setPreview((current) => { current?.close(); return null; });
        setPainted(false);
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
            if (attempt !== attemptRef.current) {
                opened.close();
                tab?.close();
                return;
            }
            if (previewUrlNeedsTab(opened.url)) {
                if (tab !== null) tab.location.href = opened.url;
                else if (window.open(opened.url, '_blank') === null) {
                    // A blocked pop-up is not an opened preview.
                    opened.close();
                    setError('Your browser blocked the new tab. Allow pop-ups for this site, then open the preview again.');
                    return;
                }
            } else {
                tab?.close();
            }
            setPreview(opened);
        } catch (cause: unknown) {
            tab?.close();
            if (attempt !== attemptRef.current) return;
            setError(humanError(cause).message);
        } finally {
            if (attempt === attemptRef.current) setOpening(false);
        }
    }, []);

    // Framed previews must paint within the bound or say so with a retry.
    const framed = preview !== null && !previewUrlNeedsTab(preview.url);
    React.useEffect(() => {
        if (!framed || painted) return;
        const timer = setTimeout(() => {
            setPreview((current) => { current?.close(); return null; });
            setError(`localhost:${directPort ?? ''} did not load in time. Check the dev server is running, then retry.`);
        }, FIRST_PAINT_TIMEOUT_MS);
        return () => clearTimeout(timer);
    }, [directPort, framed, generation, painted]);
    const reload = React.useCallback(() => { setPainted(false); setGeneration((value) => value + 1); }, []);

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
            return (
                <View style={{ flex: 1 }}>
                    {/* A same-origin bridge page may only ever live inside the
                        opaque sandbox: opened top-level it would run with the
                        PWA origin and its stored device secrets. Only an
                        independently isolated origin gets an Open control. */}
                    <PreviewBar label={`localhost:${directPort ?? ''}`} onReload={reload} onOpen={previewMayOpenTopLevel(preview.url, window.location.href) ? () => window.open(preview.url, '_blank') : undefined} />
                    {!painted && <ActivityIndicator size="small" color={theme.colors.textSecondary} style={{ position: 'absolute', top: 52, alignSelf: 'center' }} />}
                    <iframe key={generation} src={preview.url} onLoad={() => setPainted(true)} sandbox={previewUrlIsSandboxed(preview.url) ? PREVIEW_SANDBOX : undefined} style={{ flex: 1, border: 'none' }} title="preview" />
                </View>
            );
        }
        return (
            <View style={{ flex: 1 }}>
                <PreviewBar
                    label={`localhost:${directPort ?? ''}`}
                    canGoBack={nav.canGoBack}
                    canGoForward={nav.canGoForward}
                    onBack={() => webViewRef.current?.goBack()}
                    onForward={() => webViewRef.current?.goForward()}
                    onReload={() => { setPainted(false); webViewRef.current?.reload(); }}
                    onOpen={() => void Linking.openURL(preview.url)}
                />
                <WebView
                    ref={webViewRef}
                    source={{ uri: preview.url }}
                    style={{ flex: 1, backgroundColor: theme.colors.groupped.background }}
                    originWhitelist={['*']}
                    javaScriptEnabled
                    domStorageEnabled
                    startInLoadingState
                    onLoadEnd={() => setPainted(true)}
                    onNavigationStateChange={(state) => setNav({ canGoBack: state.canGoBack, canGoForward: state.canGoForward })}
                    onError={({ nativeEvent }) => { setPreview((current) => { current?.close(); return null; }); setError(humanError(nativeEvent.description).message); }}
                />
            </View>
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
