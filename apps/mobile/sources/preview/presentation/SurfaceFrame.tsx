import * as React from 'react';
import { View } from 'react-native';
import { WebView, type WebView as WebViewType, type WebViewProps } from 'react-native-webview';
import { useUnistyles } from 'react-native-unistyles';
import { surfaceNavigationAllowed, type PreviewBootstrap, type SurfaceFrameHandle, type SurfaceFrameProps } from './surfaceFrameContract';

export { isDirectUrl, surfaceNavigationAllowed } from './surfaceFrameContract';
export type { SurfaceFrameHandle, SurfaceFrameMode, SurfaceFrameProps } from './surfaceFrameContract';

/** Native frames drive real history, so Back and Forward are real controls. */
export const SURFACE_FRAME_HAS_HISTORY = true;

const READMIT_TIMEOUT_MS = 15_000;

/** The one-use bootstrap as a WebView source: the body rides the POST, never the URL. */
function bootstrapSource(origin: string, bootstrap: PreviewBootstrap): WebViewProps['source'] {
    return {
        uri: `${origin}${bootstrap.path}`,
        method: 'POST',
        body: bootstrap.body,
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
    };
}

/**
 * Native surface frame: one hardened WebView policy, one place.
 *
 * No `onMessage`, no injected script, no file access, no new windows, no
 * mixed HTTP, and the app's own navigation handler is the only policy --
 * `originWhitelist` stays wide so the library never silently hands a
 * rejected URL to the OS. Local mode's first load is the bootstrap POST;
 * the `__Host-` cookie then lives in the shared WebView store and every
 * later navigation is ordinary, admitted only inside the exact origin.
 * Direct mode admits credential-free HTTPS and the honest blank tab.
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
    const refusedRef = React.useRef(props.onAdmissionRefused);
    refusedRef.current = props.onAdmissionRefused;
    const [aux, setAux] = React.useState<{ source: WebViewProps['source']; settle: (error?: Error) => void } | null>(null);
    const local = props.mode.kind === 'local' ? props.mode : null;
    // The bootstrap is consumed by the first load only; a later re-render
    // with the same admission must not re-post it.
    const source = React.useMemo<WebViewProps['source']>(
        () => (local === null ? { uri: props.uri } : bootstrapSource(local.origin, local.bootstrap)),
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [local?.origin, local?.bootstrap.body, local === null ? props.uri : null],
    );
    React.useImperativeHandle(ref, () => ({
        // After the bootstrap redirect the current entry is the app URL, so a
        // native reload is a GET of that page, never a second POST.
        reload: () => webRef.current?.reload(),
        goBack: () => webRef.current?.goBack(),
        goForward: () => webRef.current?.goForward(),
        stop: () => webRef.current?.stopLoading(),
        readmit: (bootstrap) => new Promise<void>((resolve, reject) => {
            if (local === null) {
                reject(new Error('Only a local app can be readmitted.'));
                return;
            }
            const timer = setTimeout(() => settle(new Error('The preview did not answer the new admission in time.')), READMIT_TIMEOUT_MS);
            const settle = (error?: Error): void => {
                clearTimeout(timer);
                setAux(null);
                if (error === undefined) resolve();
                else reject(error);
            };
            setAux({ source: bootstrapSource(local.origin, bootstrap), settle });
        }),
    }), [local]);
    const hardened = {
        originWhitelist: ['*'],
        sharedCookiesEnabled: true,
        allowFileAccess: false,
        allowFileAccessFromFileURLs: false,
        allowUniversalAccessFromFileURLs: false,
        javaScriptCanOpenWindowsAutomatically: false,
        setSupportMultipleWindows: false,
        mixedContentMode: 'never' as const,
        domStorageEnabled: true,
    };
    return (
        <View style={{ flex: 1 }}>
            <WebView
                ref={webRef}
                source={source}
                {...hardened}
                onShouldStartLoadWithRequest={(request) => {
                    if (surfaceNavigationAllowed(request.url, modeRef.current)) return true;
                    // Top frame only: an HTTPS iframe inside a local page is not
                    // a user navigation. Android does not report the flag; an
                    // absent flag reads as top-level rather than swallowing it.
                    const nested = (request as { isTopFrame?: boolean }).isTopFrame === false;
                    if (!nested) blockedRef.current?.(request.url);
                    return false;
                }}
                allowsBackForwardNavigationGestures
                onScroll={() => interactRef.current?.()}
                onTouchStart={() => interactRef.current?.()}
                onRenderProcessGone={() => props.onRendererGone?.()}
                onContentProcessDidTerminate={() => props.onRendererGone?.()}
                onLoadStart={props.onLoadStart}
                onLoadEnd={props.onLoadEnd}
                onNavigationStateChange={(state) => props.onNavigation?.({ canGoBack: state.canGoBack, canGoForward: state.canGoForward, url: state.url })}
                onHttpError={({ nativeEvent }) => {
                    // The gateway refusing the main document on its own origin
                    // means the admission cookie is gone; anything else is the
                    // app's own business.
                    const mode = modeRef.current;
                    if (mode.kind !== 'local' || nativeEvent.statusCode !== 403) return;
                    if (surfaceNavigationAllowed(nativeEvent.url, mode)) refusedRef.current?.();
                }}
                onError={({ nativeEvent }) => props.onError?.(nativeEvent.description || 'The page failed to load.')}
                style={{ flex: 1, backgroundColor: theme.colors.surface }}
            />
            {aux !== null && (
                // Hidden auxiliary WebView sharing the cookie store: it posts a
                // fresh bootstrap and is gone once the gateway has answered, so
                // the main document keeps running and reconnects on its own.
                <View style={{ position: 'absolute', width: 1, height: 1, opacity: 0 }} pointerEvents="none" accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
                    <WebView
                        source={aux.source}
                        {...hardened}
                        onShouldStartLoadWithRequest={(request) => surfaceNavigationAllowed(request.url, modeRef.current)}
                        onLoadEnd={() => aux.settle()}
                        onError={({ nativeEvent }) => aux.settle(new Error(nativeEvent.description || 'The preview did not accept the new admission.'))}
                        style={{ width: 1, height: 1 }}
                    />
                </View>
            )}
        </View>
    );
});
