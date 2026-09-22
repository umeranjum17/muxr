import * as React from 'react';
import { PLUGIN_CALL_CLIENT_TIMEOUT_MS, type UsageNow } from '@muxr/contract';
import { sync } from '@/catalog/sync';
import { useForegroundRefresh } from './useForegroundRefresh';

/** How long a collected answer stays good enough to show as it is. Quota
 *  windows move over hours, so within this the cached figures are the answer
 *  and asking again costs a full collection for nothing. Past it the read asks
 *  the host to collect again rather than be served the same payload: the usage
 *  cache answers with any same-day payload, so nothing else makes figures a
 *  reader can see are old become current. Doubles as the refresh cadence. */
const FRESH_MS = 15 * 60_000;

/** `collecting` is the host saying its usage cache was cold, not that there is
 *  nothing to have: it answers with the vitals it already measured while the
 *  collection it just started keeps running and warms the cache behind the
 *  reply. Asking again is what finishes that read. */
const COLLECTING_RETRY_MS = 6_000;

/** Long enough to outlast a full cold collection. Past it the host is not
 *  collecting, it is failing to, and the card has to say so rather than claim
 *  to be collecting for as long as the app is open. */
const COLLECTING_ATTEMPTS = 6;

/** A forced read skips the host's cache, so it costs a whole collection and
 *  asks every connected provider again. An intentional tap is always worth
 *  honouring, but a run of them must not hammer services that are themselves
 *  rate limited -- and that the card exists to report on. */
const FORCED_MIN_INTERVAL_MS = 10_000;

export interface UsageNowRead {
    value?: UsageNow;
    /** The last read did not produce figures. Whatever `value` holds is still
     *  the best known answer and stays on screen with its age. */
    failed: boolean;
    /** A read is in flight behind the figures currently shown. */
    refreshing: boolean;
    /** Ask now, past the host's cache. */
    refresh: () => void;
}

/**
 * One usage.now read's lifecycle: a request token so a slow answer can never
 * overwrite a newer one, one read at a time, and the last-known value retained
 * through a transient failure -- only a load with nothing to show becomes the
 * retry card.
 *
 * Stale while revalidate throughout: what was last known paints immediately,
 * a newer answer replaces it when it lands, and neither a cold answer nor a
 * failed one ever takes good figures off the screen.
 */
export function useUsageNow(): UsageNowRead {
    const [state, setState] = React.useState<{ value?: UsageNow; failed: boolean; refreshing: boolean }>({ failed: false, refreshing: false });
    const version = React.useRef(0);
    const loading = React.useRef(false);
    const collecting = React.useRef(0);
    const lastForced = React.useRef(0);
    const followUp = React.useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
    const latest = React.useRef<(forced: boolean) => void>(() => {});
    const shown = React.useRef<UsageNow | undefined>(undefined);
    shown.current = state.value;

    const load = React.useCallback((forced: boolean) => {
        // One read at a time. A tap during a background read is the same read,
        // so it joins it rather than stacking a second ask -- and still turns
        // the control on, because the tap did do something.
        if (loading.current) { setState((current) => ({ ...current, refreshing: true })); return; }
        if (followUp.current !== undefined) { clearTimeout(followUp.current); followUp.current = undefined; }
        const force = forced && Date.now() - lastForced.current >= FORCED_MIN_INTERVAL_MS;
        if (force) lastForced.current = Date.now();
        loading.current = true;
        const request = ++version.current;
        setState((current) => ({ ...current, refreshing: true }));
        void sync.request('usage.now', force ? { refresh: true } : {}, PLUGIN_CALL_CLIENT_TIMEOUT_MS)
            .then((result) => {
                if (request !== version.current) return;
                if (result.collecting !== true) {
                    collecting.current = 0;
                    setState({ value: result, failed: false, refreshing: false });
                    return;
                }
                collecting.current += 1;
                const exhausted = collecting.current >= COLLECTING_ATTEMPTS;
                // A cold answer never takes collected figures off the screen:
                // showing what was last known is the whole point of refreshing
                // behind it. With nothing collected yet it still paints, so the
                // vitals it does carry are not withheld either.
                setState((current) => ({
                    value: current.value !== undefined && current.value.collecting !== true ? current.value : result,
                    failed: exhausted,
                    refreshing: !exhausted,
                }));
                if (exhausted) return;
                followUp.current = setTimeout(() => { followUp.current = undefined; latest.current(false); }, COLLECTING_RETRY_MS);
            })
            // A refresh that failed leaves the figures it could not replace
            // exactly where they were, with their age, and says so.
            .catch(() => {
                if (request === version.current) setState((current) => ({ ...current, failed: true, refreshing: false }));
            })
            .finally(() => {
                if (request === version.current) loading.current = false;
            });
    }, []);
    latest.current = load;

    // A tap is a fresh start, not one more of the follow-ups that just ran out.
    const refresh = React.useCallback(() => { collecting.current = 0; latest.current(true); }, []);

    useForegroundRefresh(React.useCallback(() => {
        // Only figures already known to be past their window are worth a whole
        // collection; anything newer is served from the host's cache.
        const age = shown.current?.ageSeconds;
        latest.current(age !== undefined && age * 1_000 >= FRESH_MS);
    }, []), FRESH_MS);

    React.useEffect(() => () => {
        version.current += 1;
        loading.current = false;
        if (followUp.current !== undefined) { clearTimeout(followUp.current); followUp.current = undefined; }
    }, []);

    return { value: state.value, failed: state.failed, refreshing: state.refreshing, refresh };
}
