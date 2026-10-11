import * as React from 'react';

// Native ships Skia in the binary. Keep the browser loader out of Metro's
// native graph; a Platform.OS guard still makes Metro resolve its imports.
export function loadSkiaWeb(): Promise<void> {
    return Promise.resolve();
}

export function useSkiaWeb(): boolean {
    return true;
}

export function SkiaWebGate({ children }: { children: React.ReactNode }) {
    return <>{children}</>;
}
