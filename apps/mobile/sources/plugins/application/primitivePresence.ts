import type { PluginPrimitive } from '@trymuxr/contract';

export type MountedSurface = PluginPrimitive | 'realtime-session-overlay';

const mounted = new Map<MountedSurface, number>();
const waiters = new Map<MountedSurface, Set<(ready: boolean) => void>>();

/** Track mounted platform surfaces so capabilities can wait for real UI readiness. */
export function mountPrimitive(primitive: MountedSurface): () => void {
    mounted.set(primitive, (mounted.get(primitive) ?? 0) + 1);
    for (const resolve of waiters.get(primitive) ?? []) resolve(true);
    waiters.delete(primitive);
    return () => mounted.set(primitive, Math.max(0, (mounted.get(primitive) ?? 1) - 1));
}

export function waitForPrimitive(primitive: MountedSurface, timeoutMs = 5_000): Promise<boolean> {
    if ((mounted.get(primitive) ?? 0) > 0) return Promise.resolve(true);
    return new Promise((resolve) => {
        const pending = waiters.get(primitive) ?? new Set<(ready: boolean) => void>();
        let timer: ReturnType<typeof setTimeout>;
        const done = (ready: boolean) => {
            clearTimeout(timer);
            pending.delete(done);
            if (pending.size === 0) waiters.delete(primitive);
            resolve(ready);
        };
        pending.add(done);
        waiters.set(primitive, pending);
        timer = setTimeout(() => done(false), timeoutMs);
    });
}
