import * as React from 'react';
import { Text, View } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import { WebView } from 'react-native-webview';
import { useUnistyles } from 'react-native-unistyles';

function safeHttps(value: unknown): string | undefined {
    if (typeof value !== 'string' || value.length > 2048) return undefined;
    try {
        const url = new URL(value);
        return url.protocol === 'https:' && url.username === '' && url.password === '' ? url.toString() : undefined;
    } catch {
        return undefined;
    }
}

/** Kernel-owned HTTPS viewer. Redirects to non-HTTPS schemes are blocked. */
export default function PluginWebView() {
    const { theme } = useUnistyles();
    const params = useLocalSearchParams<{ url?: string | string[] }>();
    const url = safeHttps(Array.isArray(params.url) ? params.url[0] : params.url);
    if (url === undefined) return <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: theme.colors.surface }}><Text style={{ color: theme.colors.textSecondary }}>This plugin link is unavailable.</Text></View>;
    return <WebView
        source={{ uri: url }}
        originWhitelist={['https://*']}
        allowFileAccess={false}
        allowUniversalAccessFromFileURLs={false}
        mixedContentMode="never"
        setSupportMultipleWindows={false}
        onShouldStartLoadWithRequest={(request) => safeHttps(request.url) !== undefined}
        style={{ flex: 1, backgroundColor: theme.colors.surface }}
    />;
}
