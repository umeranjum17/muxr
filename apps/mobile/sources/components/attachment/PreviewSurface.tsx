import * as React from 'react';
import WebView from 'react-native-webview';
export function PreviewSurface({ html, onError }: { html: string; onError: () => void }) {
    return <WebView source={{ html, baseUrl: 'about:blank' }} style={{ flex: 1, backgroundColor: '#fff' }}
        originWhitelist={['*']} onShouldStartLoadWithRequest={({ url }) => url === 'about:blank'}
        allowFileAccess={false} allowFileAccessFromFileURLs={false} allowUniversalAccessFromFileURLs={false}
        javaScriptCanOpenWindowsAutomatically={false} setSupportMultipleWindows sharedCookiesEnabled={false}
        thirdPartyCookiesEnabled={false} domStorageEnabled={false} cacheEnabled={false} incognito
        mixedContentMode="never" mediaPlaybackRequiresUserAction onError={onError}
        onContentProcessDidTerminate={onError} onRenderProcessGone={onError} />;
}
