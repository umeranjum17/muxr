import type { PluginsInvalidatedFrame } from '@muxr/contract';
import { registerPluginInvalidationHandler } from '@/sync/sync';

type Listener = (frame: PluginsInvalidatedFrame) => void;
type CacheInvalidator = (pluginIds: readonly string[] | undefined) => void;
const listeners = new Map<string, Set<Listener>>();
const cacheInvalidators = new Set<CacheInvalidator>();

registerPluginInvalidationHandler((frame) => {
    const affected = frame.pluginIds.length === 0 ? undefined : new Set(frame.pluginIds);
    for (const invalidate of cacheInvalidators) {
        try { invalidate(affected === undefined ? undefined : frame.pluginIds); } catch { /* one cache must not block others */ }
    }
    for (const [pluginId, pluginListeners] of listeners) {
        if (affected !== undefined && !affected.has(pluginId)) continue;
        for (const listener of pluginListeners) {
            try { listener(frame); } catch { /* one optional surface must not block the others */ }
        }
    }
});

/** Refetch one plugin's data when its catalog entry changes; empty ids means full reconnect invalidation. */
export function subscribePluginDataInvalidation(pluginId: string, listener: Listener): () => void {
    let pluginListeners = listeners.get(pluginId);
    if (pluginListeners === undefined) {
        pluginListeners = new Set();
        listeners.set(pluginId, pluginListeners);
    }
    pluginListeners.add(listener);
    return () => {
        pluginListeners!.delete(listener);
        if (pluginListeners!.size === 0) listeners.delete(pluginId);
    };
}

export function registerPluginDataCacheInvalidator(invalidator: CacheInvalidator): () => void {
    cacheInvalidators.add(invalidator);
    return () => cacheInvalidators.delete(invalidator);
}

export function clearPluginCache<T>(cache: Map<string, T>, pluginId: string): void {
    const prefix = `${pluginId}:`;
    for (const key of cache.keys()) if (key.startsWith(prefix)) cache.delete(key);
}
