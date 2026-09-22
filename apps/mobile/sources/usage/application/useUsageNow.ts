import * as React from 'react';
import { PLUGIN_CALL_CLIENT_TIMEOUT_MS, type UsageNow } from '@muxr/contract';
import { sync } from '@/catalog/sync';
import { forcedReadWait } from './forcedRead';
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

export interface UsageNowRead {
    value?: UsageNow;
    /** The last read did not produce figures. Whatever `value` holds is still
     *  the best known answer and stays on screen with its age. */
    failed: boolean;
    /** A read is in flight behind the figures currently shown. */
    refreshing: boolean;
    /** An explicit ask could not run yet: whole seconds until it can. The
     *  surface says so rather than report a refresh it did not perform. */
    throttledSeconds?: number;
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
    const [throttledSeconds, setThrottledSeconds] = React.useState<number>();
    const version = React.useRef(0);
    const loading = React.useRef(false);
    const collecting = React.useRef(0);
    const lastForced = React.useRef(0);
    const rejected = React.useRef(false);
    const pendingForce = React.useRef(false);
    const bursting = React.useRef(false);
    const revalidating = React.useRef(false);
    const revalidateAfter = React.useRef(false);
    const followUp = React.useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
    const latest = React.useRef<(force: boolean) => void>(() => {});
    const shown = React.useRef<UsageNow | undefined>(undefined);
    const shownAt = React.useRef(0);
    if (shown.current !== state.value) { shown.current = state.value; shownAt.current = Date.now(); }

    const load = React.useCallback((force: boolean): Promise<void> => {
        // One read at a time. A tap during a background read is the same read,
        // so it joins it rather than stacking a second ask -- and still turns
        // the control on, because the tap did do something.
        if (loading.current) { setState((current) => ({ ...current, refreshing: true })); return Promise.resolve(); }
        if (followUp.current !== undefined) { clearTimeout(followUp.current); followUp.current = undefined; }
        revalidateAfter.current = false;
        // The budget belongs to a forced read that actually starts: a cycle that
        // can only join the read already in flight must not spend it.
        if (force) lastForced.current = Date.now();
        // A follow-up asks the cache-respecting question on purpose: forcing it
        // again would start a second collection behind the one the read that
        // opened the burst already left running.
        const following = !force && collecting.current > 0;
        const replaced = following ? shown.current : undefined;
        const replacedAt = following ? shownAt.current : 0;
        loading.current = true;
        const request = ++version.current;
        setState((current) => ({ ...current, refreshing: true }));
        return sync.request('usage.now', force ? { refresh: true } : {}, PLUGIN_CALL_CLIENT_TIMEOUT_MS)
            .then((result) => {
                if (request !== version.current) return;
                // The host answered, so the last read was not rejected: whether
                // it produced figures is a different question (`failed`).
                rejected.current = false;
                // Only a newer payload, or an explicit failure, ends a read. The
                // host's cache replays any same-day payload, so a follow-up can
                // be answered by the very figures this read set out to replace:
                // that is not the collection finishing, and the read keeps
                // waiting rather than settling on what it already had.
                if (result.collecting !== true && (replaced === undefined || isNewer(result, replaced, replacedAt, Date.now()))) {
                    const wasRevalidation = revalidating.current;
                    revalidating.current = false;
                    collecting.current = 0;
                    bursting.current = false;
                    setState({ value: result, failed: false, refreshing: false });
                    // Stale while revalidate, and not only the stale half: figures
                    // already past their window paint at once, and one forced read
                    // makes them current behind them. It never chains -- the
                    // revalidation's own answer cannot ask for another.
                    if (!wasRevalidation && pastFreshnessWindow(result.ageSeconds)) revalidateAfter.current = true;
                    return;
                }
                collecting.current += 1;
                const exhausted = collecting.current >= COLLECTING_ATTEMPTS;
                bursting.current = !exhausted;
                if (exhausted) revalidating.current = false;
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
                if (request === version.current) {
                    revalidating.current = false;
                    bursting.current = false;
                    rejected.current = true;
                    setState((current) => ({ ...current, failed: true, refreshing: false }));
                }
            })
            .finally(() => {
                if (request !== version.current) return;
                loading.current = false;
                // A tap taken while the last read was rejected asked for a read
                // past the cache; it runs the moment the read in flight settles
                // rather than being answered by it.
                if (pendingForce.current) {
                    pendingForce.current = false;
                    revalidateAfter.current = false;
                    setThrottledSeconds(undefined);
                    collecting.current = 0;
                    bursting.current = false;
                    latest.current(true);
                    return;
                }
                if (!revalidateAfter.current) return;
                revalidateAfter.current = false;
                revalidating.current = true;
                collecting.current = 0;
                bursting.current = false;
                void load(true);
            });
    }, []);
    latest.current = load;

    // An explicit tap is a fresh start, not one more of the follow-ups that
    // just ran out, and it is always worth honouring -- but not so often that
    // it hammers rate-limited providers. A tap that cannot run says when, and a
    // read that was rejected is exempt: it consumed no provider quota, unlike a
    // collecting burst that ran out its attempts.
    const refresh = React.useCallback(() => {
        if (loading.current) {
            // A tap taken while the last read was rejected still has to end in a
            // read that skips the cache, so it is remembered and run when the
            // read in flight settles rather than answered by it.
            if (rejected.current) pendingForce.current = true;
            setState((current) => ({ ...current, refreshing: true }));
            return;
        }
        const waitSeconds = forcedReadWait(lastForced.current, rejected.current, Date.now());
        if (waitSeconds !== undefined) { setThrottledSeconds(waitSeconds); return; }
        setThrottledSeconds(undefined);
        collecting.current = 0;
        bursting.current = false;
        void load(true);
    }, [load]);

    React.useEffect(() => {
        if (throttledSeconds === undefined) return;
        const timer = setTimeout(() => setThrottledSeconds(undefined), throttledSeconds * 1_000);
        return () => clearTimeout(timer);
    }, [throttledSeconds]);

    useForegroundRefresh(React.useCallback(() => {
        // A cycle beginning while a collecting burst is still running must not
        // restart the burst's budget: bounded means bounded even across a focus.
        // Once the burst has settled this is a new cycle, and it starts whole.
        if (!bursting.current) collecting.current = 0;
        // Only figures already known to be past their window are worth a whole
        // collection; anything newer is served from the host's cache. The same
        // throttle guards this cycle, which falls back to the cheap ask rather
        // than skipping the moment.
        const force = pastFreshnessWindow(shown.current?.ageSeconds) && forcedReadWait(lastForced.current, rejected.current, Date.now()) === undefined;
        void load(force);
    }, [load]), FRESH_MS);

    React.useEffect(() => () => {
        version.current += 1;
        loading.current = false;
        if (followUp.current !== undefined) { clearTimeout(followUp.current); followUp.current = undefined; }
    }, []);

    return { value: state.value, failed: state.failed, refreshing: state.refreshing, throttledSeconds, refresh };
}

/** Whether figures are old enough to be worth a whole collection: the same
 *  window the cadence uses, applied the moment an accepted payload lands. */
function pastFreshnessWindow(ageSeconds: number | undefined): boolean {
    return ageSeconds !== undefined && ageSeconds * 1_000 >= FRESH_MS;
}

/** Whether an answer is newer than the figures it would replace. The host names
 *  the reading it served, so the same capture is exactly a cache replay and a
 *  new one is a collection that landed: an exact test.
 *
 *  An older host carries no name, and the age comparison below is then only a
 *  heuristic: the two ages were measured at different moments, so a slow frame
 *  between the two responses can make a replay look newer. It is kept so an
 *  older pairing still makes progress, not because it can be trusted. With no
 *  age to compare there is nothing to hold the read open for. */
function isNewer(next: UsageNow, previous: UsageNow, previousObservedAtMs: number, nowMs: number): boolean {
    if (next.capturedAt !== undefined && previous.capturedAt !== undefined) return next.capturedAt !== previous.capturedAt;
    if (previous.ageSeconds === undefined || next.ageSeconds === undefined) return true;
    return nowMs - next.ageSeconds * 1_000 > previousObservedAtMs - previous.ageSeconds * 1_000 + 1_000;
}
