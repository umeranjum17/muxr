import * as React from 'react';
import { PLUGIN_CALL_CLIENT_TIMEOUT_MS } from '@muxr/contract';
import { sync } from '@/catalog/sync';
import { subscribePluginDataInvalidation } from '../application/pluginDataInvalidation';

export interface PluginCallTarget {
    pluginId: string;
    manifestHash: string;
    contributionId: string;
}

/**
 * One read rpc's lifecycle, owned once: a request token so a slow answer can
 * never overwrite a newer one, an in-flight collapse so overlapping loads
 * coalesce into one call and one follow-up, the last-known value retained
 * through a transient failure, and a refetch when the host invalidates the
 * plugin's data. Callers differ only in how they read the result, so `parse`
 * is the whole difference between them and is read through a ref: an inline
 * parser must not retrigger the call.
 */
export function usePluginCall<T>(
    target: PluginCallTarget | undefined,
    parse: (result: unknown) => T,
): { value?: T; failed: boolean; retry: () => void } {
    const [state, setState] = React.useState<{ value?: T; failed: boolean }>({ failed: false });
    const version = React.useRef(0);
    const loading = React.useRef(false);
    const queued = React.useRef(false);
    const latestLoad = React.useRef<() => void>(() => {});
    const latestParse = React.useRef(parse);
    latestParse.current = parse;
    const { pluginId, manifestHash, contributionId } = target ?? {};
    const load = React.useCallback(() => {
        if (pluginId === undefined || manifestHash === undefined || contributionId === undefined) return;
        if (loading.current) { queued.current = true; return; }
        loading.current = true;
        const request = ++version.current;
        void sync.request('plugin.call', { pluginId, manifestHash, contributionId }, PLUGIN_CALL_CLIENT_TIMEOUT_MS)
            .then((result) => {
                if (request !== version.current) return;
                setState({ value: latestParse.current(result), failed: false });
            })
            .catch(() => {
                if (request === version.current) setState((current) => ({ ...current, failed: true }));
            })
            .finally(() => {
                if (request !== version.current) return;
                loading.current = false;
                if (queued.current) { queued.current = false; setTimeout(() => { if (request === version.current) latestLoad.current(); }, 0); }
            });
    }, [contributionId, manifestHash, pluginId]);
    latestLoad.current = load;
    React.useEffect(() => {
        if (pluginId === undefined) { setState({ failed: false }); return; }
        load();
        return () => { version.current += 1; loading.current = false; queued.current = false; };
    }, [load, pluginId]);
    React.useEffect(() => {
        if (pluginId === undefined) return;
        return subscribePluginDataInvalidation(pluginId, load);
    }, [load, pluginId]);
    return { value: state.value, failed: state.failed, retry: load };
}
