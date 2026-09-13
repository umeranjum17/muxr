import * as React from 'react';

/**
 * Web Skia readiness. CanvasKit (~8 MB wasm) loads once, on first real
 * Canvas use — plugin gauges/rings on wide screens — never during root
 * init. Components that need a Canvas suspend on this; everything else
 * paints without it.
 */
let load: Promise<void> | undefined;

export function ensureSkiaWeb(): Promise<void> {
    load ??= (async () => {
        const { LoadSkiaWeb } = await import('@shopify/react-native-skia/lib/module/web');
        await LoadSkiaWeb({ locateFile: (file: string) => `/${file}` });
    })();
    return load;
}

export function useSkiaWebReady(): boolean {
    const [ready, setReady] = React.useState(false);
    React.useEffect(() => {
        let live = true;
        void ensureSkiaWeb().then(() => {
            if (live) setReady(true);
        }).catch(() => {
            // Charts degrade to meter rows; the failure stays local.
        });
        return () => {
            live = false;
        };
    }, []);
    return ready;
}
