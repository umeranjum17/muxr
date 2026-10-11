import * as React from 'react';
import { Platform } from 'react-native';

// CanvasKit is the browser build of Skia: an 8 MB wasm binary the web client
// must fetch before any Skia <Canvas> or victory-native chart can draw. Native
// ships Skia in the binary, so only web has to load it. The cold landing and
// pair screen draw no Skia, so the load waits for a screen that does.
let skiaWebLoad: Promise<void> | null = null;

/** Fetch CanvasKit once, on the first screen that draws with Skia. */
export function loadSkiaWeb(): Promise<void> {
    if (Platform.OS !== 'web') return Promise.resolve();
    if (skiaWebLoad === null) {
        // Call CanvasKitInit directly rather than the library's LoadSkiaWeb
        // wrapper. That wrapper memoizes its init promise at module scope and
        // never clears it, so one failed ~8 MB wasm fetch would rethrow the
        // same rejected promise on every later mount for the rest of the
        // session. Owning the promise here is what lets a failed fetch be
        // retried; the wrapper did nothing beyond this init plus the global.
        skiaWebLoad = import('canvaskit-wasm/bin/full/canvaskit')
            .then(({ default: CanvasKitInit }) => CanvasKitInit({ locateFile: (file: string) => `/${file}` }))
            .then((CanvasKit) => { (globalThis as { CanvasKit?: unknown }).CanvasKit = CanvasKit; })
            .catch((error) => {
                skiaWebLoad = null;
                throw error;
            });
    }
    return skiaWebLoad;
}

/** True once CanvasKit is ready on web; always true on native. */
export function useSkiaWeb(): boolean {
    const [ready, setReady] = React.useState(Platform.OS !== 'web');
    React.useEffect(() => {
        if (Platform.OS !== 'web') return;
        let cancelled = false;
        void loadSkiaWeb().then(
            () => { if (!cancelled) setReady(true); },
            () => undefined,
        );
        return () => { cancelled = true; };
    }, []);
    return ready;
}

/**
 * Holds Skia-drawing children back until CanvasKit is ready on web, starting
 * the load on mount. On native it renders its children immediately. Use it
 * around any subtree that mounts a Skia <Canvas> or a victory-native chart so
 * the cold landing never pulls the wasm.
 */
export function SkiaWebGate({ children }: { children: React.ReactNode }) {
    return useSkiaWeb() ? <>{children}</> : null;
}
