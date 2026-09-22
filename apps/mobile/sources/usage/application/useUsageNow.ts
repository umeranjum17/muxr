import * as React from 'react';
import { PLUGIN_CALL_CLIENT_TIMEOUT_MS, type UsageNow } from '@muxr/contract';
import { sync } from '@/catalog/sync';
import { forcedReadWait } from './forcedRead';
import { FRESH_MS, collectionDue, lastKnownReading, noteAsked, rememberReading } from './freshnessWindow';
import { useForegroundRefresh } from './useForegroundRefresh';

/** The tab the card's read answers for: `usage.now` collects the default one,
 *  which is the same cache entry the Usage screen's default tab reads. */
const READ_TAB = '';

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
    const [state, setState] = React.useState<{ value?: UsageNow; failed: boolean; refreshing: boolean }>(() => ({ value: lastKnownReading(READ_TAB), failed: false, refreshing: false }));
    const [throttledSeconds, setThrottledSeconds] = React.useState<number>();
    const version = React.useRef(0);
    const loading = React.useRef(false);
    const collecting = React.useRef(0);
    const lastForced = React.useRef(0);
    const rejected = React.useRef(false);
    const pendingForce = React.useRef(false);
    const bursting = React.useRef(false);
    const collectAfter = React.useRef<number | undefined>(undefined);
    const followUp = React.useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
    const latest = React.useRef<(force: boolean) => void>(() => {});
    const shown = React.useRef<UsageNow | undefined>(undefined);
    const shownAt = React.useRef(0);
    if (shown.current !== state.value) { shown.current = state.value; shownAt.current = Date.now(); }
    // What is on screen is what a remount should find, so the memory beside the
    // ask record never lags the figures a reader was shown.
    React.useEffect(() => { if (state.value !== undefined) rememberReading(READ_TAB, state.value); }, [state.value]);
    // The card is reading unavailable: a tap on it must end in a read that
    // bypasses the cache, whatever else is in flight.
    const unavailable = React.useRef(false);
    unavailable.current = state.failed;

    /**
     * `force` asks the host to collect past its cache; such a read claims our
     * own window and the shared budget at `claimedAtMs`, the instant the
     * decision to collect was taken, so the next cycle measures a whole window
     * from where it decided rather than from a round trip. Every other read is
     * cache-respecting: the figures the host already holds are what a reader
     * sees, and a collection runs behind them rather than in place of them.
     */
    const load = React.useCallback((force: boolean, claimedAtMs = Date.now()): Promise<void> => {
        // One read at a time. A tap during a background read is the same read,
        // so it joins it rather than stacking a second ask -- and still turns
        // the control on, because the tap did do something.
        if (loading.current) { setState((current) => ({ ...current, refreshing: true })); return Promise.resolve(); }
        if (followUp.current !== undefined) { clearTimeout(followUp.current); followUp.current = undefined; }
        // The budget belongs to a forced read that actually starts: a cycle that
        // can only join the read already in flight must not spend it, and the
        // window opens only where we really ask.
        if (force) { lastForced.current = claimedAtMs; noteAsked(READ_TAB, claimedAtMs); }
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
                    collecting.current = 0;
                    bursting.current = false;
                    setState({ value: result, failed: false, refreshing: false });
                    return;
                }
                collecting.current += 1;
                const exhausted = collecting.current >= COLLECTING_ATTEMPTS;
                bursting.current = !exhausted;
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
                    collectAfter.current = undefined;
                    setThrottledSeconds(undefined);
                    collecting.current = 0;
                    bursting.current = false;
                    void load(true);
                    return;
                }
                // The figures the host already had have painted, so the one
                // collection our own window authorized runs now.
                const claimedAt = collectAfter.current;
                if (claimedAt === undefined) return;
                collectAfter.current = undefined;
                if (forcedReadWait(lastForced.current, rejected.current, Date.now()) !== undefined) return;
                collecting.current = 0;
                bursting.current = false;
                void load(true, claimedAt);
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
            // A tap on a card reading unavailable still has to end in a read
            // that skips the cache, so it is remembered and run when the read
            // in flight settles rather than being answered by it.
            if (unavailable.current) pendingForce.current = true;
            setState((current) => ({ ...current, refreshing: true }));
            return;
        }
        const now = Date.now();
        const waitSeconds = forcedReadWait(lastForced.current, rejected.current, now);
        if (waitSeconds !== undefined) { setThrottledSeconds(waitSeconds); return; }
        setThrottledSeconds(undefined);
        collecting.current = 0;
        bursting.current = false;
        void load(true, now);
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
        // Our own window gates every ask, cheap or forced. Inside it the card
        // paints what it already holds and asks nothing at all; once it has
        // passed the ask is ours, noted here at the instant we take the
        // decision, with the figures the host already holds painting first and
        // the one collection running behind them. A card holding nothing yet
        // asks whatever the record says: a window is no use with a blank card.
        const now = Date.now();
        const due = collectionDue(READ_TAB, now);
        if (!due && shown.current !== undefined) return;
        if (due) {
            noteAsked(READ_TAB, now);
            collectAfter.current = now;
        }
        void load(false);
    }, [load]), FRESH_MS);

    React.useEffect(() => () => {
        version.current += 1;
        loading.current = false;
        if (followUp.current !== undefined) { clearTimeout(followUp.current); followUp.current = undefined; }
    }, []);

    return { value: state.value, failed: state.failed, refreshing: state.refreshing, throttledSeconds, refresh };
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
