import * as React from 'react';

/**
 * Skia readiness. Native ships Skia in the binary, so this is immediately
 * ready. Web lazy-loads CanvasKit on first real Canvas use — never at root,
 * so the multi-megabyte wasm stays out of usable-load readiness.
 */
export function useSkiaWebReady(): boolean {
    return true;
}

export function ensureSkiaWeb(): Promise<void> {
    return Promise.resolve();
}

export function SkiaWebGate({ children }: { children: React.ReactNode }): React.ReactNode {
    return children;
}
