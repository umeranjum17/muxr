import * as React from 'react';
import { PLUGIN_CALL_CLIENT_TIMEOUT_MS, type UsageNow } from '@muxr/contract';
import { sync } from '@/catalog/sync';

/**
 * One usage.now read's lifecycle: a request token so a slow answer can never
 * overwrite a newer one, an in-flight collapse, and the last-known value
 * retained through a transient failure -- only a load with nothing to show
 * becomes the retry card.
 */
export function useUsageNow(): { value?: UsageNow; failed: boolean; retry: () => void } {
    const [state, setState] = React.useState<{ value?: UsageNow; failed: boolean }>({ failed: false });
    const version = React.useRef(0);
    const loading = React.useRef(false);
    const queued = React.useRef(false);
    const latestLoad = React.useRef(() => {});
    const load = React.useCallback(() => {
        if (loading.current) { queued.current = true; return; }
        loading.current = true;
        const request = ++version.current;
        void sync.request('usage.now', {}, PLUGIN_CALL_CLIENT_TIMEOUT_MS)
            .then((result) => {
                if (request !== version.current) return;
                setState({ value: result, failed: false });
            })
            .catch(() => {
                if (request === version.current) setState((current) => ({ ...current, failed: true }));
            })
            .finally(() => {
                if (request !== version.current) return;
                loading.current = false;
                if (queued.current) { queued.current = false; setTimeout(() => { if (request === version.current) latestLoad.current(); }, 0); }
            });
    }, []);
    latestLoad.current = load;
    React.useEffect(() => {
        load();
        return () => { version.current += 1; loading.current = false; queued.current = false; };
    }, [load]);
    return { value: state.value, failed: state.failed, retry: load };
}
