import * as React from 'react';
import { PLUGIN_CALL_CLIENT_TIMEOUT_MS, type UsageNow, type UsageVitals } from '@muxr/contract';
import { sync } from '@/catalog/sync';
import { forcedReadWait } from './forcedRead';
import { FRESH_MS, collectionDue, lastForcedRead, noteAsked, noteForcedRead, releaseAsked, rememberShown, shownUsage, subscribeUsage, usageWrites, withNow, type UsageDisplay, type UsageFigures } from './freshnessWindow';
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

/** The wait a mount shows before its own ask has answered anything. */
const NOTHING_SHOWN_YET: UsageDisplay = { status: 'waiting', askedAt: 0 };

/** The machine facts a display carries, when it carries them: measured vitals
 *  are figures a reader can keep while the plan half is still being collected. */
function measured(source: { vitals?: UsageVitals }): { vitals?: UsageVitals } {
    return source.vitals === undefined ? {} : { vitals: source.vitals };
}

export interface UsageNowRead {
    /** Figures, a wait, or a failure: the card paints one of the three and has
     *  no fourth to fall back on. */
    display: UsageDisplay;
    /** The last read did not produce figures. What `display` holds is still the
     *  best known answer and stays on screen with its age. */
    failed: boolean;
    /** A read is in flight behind the display. */
    refreshing: boolean;
    /** An explicit ask could not run yet: whole seconds until it can. The
     *  surface says so rather than report a refresh it did not perform. */
    throttledSeconds?: number;
    /** Ask now, past the host's cache. */
    refresh: () => void;
}

/**
 * One usage.now read's lifecycle: a request token so a slow answer can never
 * overwrite a newer one, one read at a time, and the figures retained through a
 * transient failure. What there is to show lives in the shared per-machine
 * store beside the ask record, which this hook both writes and subscribes to,
 * so a blank is not one of the states it can be in.
 */
export function useUsageNow(): UsageNowRead {
    React.useSyncExternalStore(subscribeUsage, usageWrites);
    const display = shownUsage(READ_TAB) ?? NOTHING_SHOWN_YET;
    const [failed, setFailed] = React.useState(false);
    const [refreshing, setRefreshing] = React.useState(false);
    const [throttledSeconds, setThrottledSeconds] = React.useState<number>();
    const version = React.useRef(0);
    const loading = React.useRef(false);
    const collecting = React.useRef(0);
    const rejected = React.useRef(false);
    const pendingForce = React.useRef(false);
    const bursting = React.useRef(false);
    const followUp = React.useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
    const latest = React.useRef<(force: boolean) => void>(() => {});
    const displayRef = React.useRef(display);
    displayRef.current = display;
    const figures = display.status === 'figures' ? display.figures : undefined;
    const shown = React.useRef<UsageFigures | undefined>(undefined);
    const shownAt = React.useRef(0);
    if (shown.current !== figures) { shown.current = figures; shownAt.current = display.status === 'figures' ? display.at : 0; }
    // The card is reading unavailable: a tap on it must end in a read that
    // bypasses the cache, whatever else is in flight.
    const unavailable = React.useRef(false);
    unavailable.current = failed || display.status === 'unavailable';
    // The claim of the forced read in flight, for as long as its answer is
    // outstanding: a read abandoned before that has no answer coming.
    const claim = React.useRef<number | undefined>(undefined);

    /**
     * `force` asks the host to collect past its cache; such a read claims our
     * own window and the shared budget at `claimedAtMs`, the instant the
     * decision to collect was taken, so the next cycle measures a whole window
     * from where it decided rather than from a round trip.
     */
    const load = React.useCallback((force: boolean, claimedAtMs = Date.now()): Promise<void> => {
        // One read at a time. A tap during a background read is the same read,
        // so it joins it rather than stacking a second ask -- and still turns
        // the control on, because the tap did do something.
        if (loading.current) { setRefreshing(true); return Promise.resolve(); }
        if (followUp.current !== undefined) { clearTimeout(followUp.current); followUp.current = undefined; }
        // The budget belongs to a forced read that actually starts: a cycle that
        // can only join the read already in flight must not spend it, and the
        // window opens only where we really ask.
        if (force) { noteForcedRead(READ_TAB, claimedAtMs); noteAsked(READ_TAB, claimedAtMs); claim.current = claimedAtMs; }
        // A follow-up asks the cache-respecting question on purpose: forcing it
        // again would start a second collection behind the one the read that
        // opened the burst already left running.
        const following = !force && collecting.current > 0;
        const replaced = following ? shown.current : undefined;
        const replacedAt = following ? shownAt.current : 0;
        // No answer is coming for this read once it is superseded: let its claim
        // go, so the tab is back to not having been asked.
        const abandon = () => { if (force && claim.current === claimedAtMs) { claim.current = undefined; releaseAsked(READ_TAB, claimedAtMs); } };
        loading.current = true;
        const request = ++version.current;
        // What is on screen stays there while a read runs behind it: figures a
        // reader can see, or the failure whose retry this is. Only a wait is
        // replaced by the wait it already is.
        const before = displayRef.current;
        if (before.status === 'waiting') rememberShown(READ_TAB, { status: 'waiting', askedAt: claimedAtMs, ...measured(before) });
        setRefreshing(true);
        return sync.request('usage.now', force ? { refresh: true } : {}, PLUGIN_CALL_CLIENT_TIMEOUT_MS)
            .then((result) => {
                if (request !== version.current) { abandon(); return; }
                claim.current = undefined;
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
                    setFailed(false);
                    setRefreshing(false);
                    rememberShown(READ_TAB, { status: 'figures', at: Date.now(), figures: withNow(shown.current, result) });
                    return;
                }
                collecting.current += 1;
                const exhausted = collecting.current >= COLLECTING_ATTEMPTS;
                bursting.current = !exhausted;
                // A cold answer never takes collected figures off the screen:
                // showing what was last known is the whole point of refreshing
                // behind it. With nothing collected yet it says what it is -- a
                // host still collecting, or one that never finished.
                setFailed(exhausted);
                setRefreshing(!exhausted);
                if (displayRef.current.status !== 'figures') {
                    rememberShown(READ_TAB, exhausted
                        ? { status: 'unavailable', reason: '', ...measured(result) }
                        : { status: 'waiting', askedAt: claimedAtMs, ...measured(result) });
                }
                if (exhausted) return;
                followUp.current = setTimeout(() => { followUp.current = undefined; latest.current(false); }, COLLECTING_RETRY_MS);
            })
            // A refresh that failed leaves the figures it could not replace
            // exactly where they were, with their age, and says so.
            .catch((cause: unknown) => {
                if (request !== version.current) { abandon(); return; }
                claim.current = undefined;
                {
                    bursting.current = false;
                    rejected.current = true;
                    setFailed(true);
                    setRefreshing(false);
                    if (displayRef.current.status !== 'figures') {
                        rememberShown(READ_TAB, { status: 'unavailable', reason: cause instanceof Error ? cause.message : String(cause), ...measured(displayRef.current) });
                    }
                }
            })
            .finally(() => {
                if (request !== version.current) { abandon(); return; }
                claim.current = undefined;
                loading.current = false;
                // A tap on a card reading unavailable asked for a read past the
                // cache; it runs the moment the read in flight settles rather
                // than being answered by it.
                if (!pendingForce.current) return;
                pendingForce.current = false;
                setThrottledSeconds(undefined);
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
            // A tap on a card reading unavailable still has to end in a read
            // that skips the cache, so it is remembered and run when the read
            // in flight settles rather than being answered by it.
            if (unavailable.current) pendingForce.current = true;
            setRefreshing(true);
            return;
        }
        const now = Date.now();
        const waitSeconds = forcedReadWait(lastForcedRead(READ_TAB), rejected.current, now);
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
        // Our own window decides whether this cycle asks at all, and the single
        // request it sends is the collection itself -- no cheap read first, so a
        // host with nothing stored collects once rather than twice. Inside the
        // window the card paints what the shared store holds and asks nothing,
        // and a first view with nothing held is just an open window with no
        // record. The request claims the window at this instant, the decision.
        const now = Date.now();
        if (!collectionDue(READ_TAB, now)) return;
        void load(true, now);
    }, [load]), FRESH_MS);

    React.useEffect(() => () => {
        version.current += 1;
        loading.current = false;
        if (claim.current !== undefined) { releaseAsked(READ_TAB, claim.current); claim.current = undefined; }
        if (followUp.current !== undefined) { clearTimeout(followUp.current); followUp.current = undefined; }
    }, []);

    return { display, failed, refreshing, throttledSeconds, refresh };
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
function isNewer(next: UsageNow, previous: { capturedAt?: string; ageSeconds?: number }, previousObservedAtMs: number, nowMs: number): boolean {
    if (next.capturedAt !== undefined && previous.capturedAt !== undefined) return next.capturedAt !== previous.capturedAt;
    if (previous.ageSeconds === undefined || next.ageSeconds === undefined) return true;
    return nowMs - next.ageSeconds * 1_000 > previousObservedAtMs - previous.ageSeconds * 1_000 + 1_000;
}
