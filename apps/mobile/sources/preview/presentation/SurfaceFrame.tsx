import * as React from 'react';
import { WebView, type WebView as WebViewType } from 'react-native-webview';
import { useUnistyles } from 'react-native-unistyles';
import { surfaceNavigationAllowed, type SurfaceFrameHandle, type SurfaceFrameProps } from './surfaceFrameContract';

export { isDirectUrl, surfaceNavigationAllowed } from './surfaceFrameContract';
export type { SurfaceFrameHandle, SurfaceFrameMode, SurfaceFrameProps } from './surfaceFrameContract';

/** Native frames drive real history, so Back and Forward are real controls. */
export const SURFACE_FRAME_HAS_HISTORY = true;

/**
 * Native surface frame: one hardened WebView policy, one place.
 *
 * No `onMessage`, no injected script, no file access, no new windows, no
 * mixed HTTP, and the app's own navigation handler is the only policy --
 * `originWhitelist` stays wide so the library never silently hands a
 * rejected URL to the OS. Local mode admits only the exact tunnel origin;
 * direct mode admits credential-free HTTPS and the honest blank tab.
 */
export const SurfaceFrame = React.forwardRef<SurfaceFrameHandle, SurfaceFrameProps>(function SurfaceFrame(props, ref) {
    const { theme } = useUnistyles();
    const webRef = React.useRef<WebViewType | null>(null);
    const modeRef = React.useRef(props.mode);
    modeRef.current = props.mode;
    const blockedRef = React.useRef(props.onBlockedUrl);
    blockedRef.current = props.onBlockedUrl;
    const interactRef = React.useRef(props.onInteract);
    interactRef.current = props.onInteract;
    React.useImperativeHandle(ref, () => ({
        reload: () => webRef.current?.reload(),
        goBack: () => webRef.current?.goBack(),
        goForward: () => webRef.current?.goForward(),
        stop: () => webRef.current?.stopLoading(),
    }), []);
    return (
        <WebView
            ref={webRef}
            source={{ uri: props.uri }}
            originWhitelist={['*']}
            onShouldStartLoadWithRequest={(request) => {
                if (surfaceNavigationAllowed(request.url, modeRef.current)) return true;
                // Top frame only: an HTTPS iframe inside a local page is not
                // a user navigation. Android does not report the flag; an
                // absent flag reads as top-level rather than swallowing it.
                const nested = (request as { isTopFrame?: boolean }).isTopFrame === false;
                if (!nested) blockedRef.current?.(request.url);
                return false;
            }}
            sharedCookiesEnabled
            allowFileAccess={false}
            allowFileAccessFromFileURLs={false}
            allowUniversalAccessFromFileURLs={false}
            javaScriptCanOpenWindowsAutomatically={false}
            setSupportMultipleWindows={false}
            mixedContentMode="never"
            domStorageEnabled
            allowsBackForwardNavigationGestures
            onScroll={() => interactRef.current?.()}
            onTouchStart={() => interactRef.current?.()}
            onRenderProcessGone={() => props.onRendererGone?.()}
            onContentProcessDidTerminate={() => props.onRendererGone?.()}
            onLoadStart={props.onLoadStart}
            onLoadEnd={props.onLoadEnd}
            onNavigationStateChange={(state) => props.onNavigation?.({ canGoBack: state.canGoBack, canGoForward: state.canGoForward, url: state.url })}
            onError={({ nativeEvent }) => props.onError?.(nativeEvent.description || 'The page failed to load.')}
            style={{ flex: 1, backgroundColor: theme.colors.surface }}
        />
    );
});
