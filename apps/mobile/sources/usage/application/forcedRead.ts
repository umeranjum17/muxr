/** A forced read skips the host's cache, so it costs a whole collection and
 *  asks every connected provider again -- services that are themselves rate
 *  limited, and that these figures exist to report on. An intentional ask is
 *  always worth honouring, but a run of them must not hammer providers. One
 *  rule, in one place, for every surface that asks now: the Home card's
 *  freshness control and its cadence, and the Usage screen's header control
 *  and pull gesture. */
const FORCED_MIN_INTERVAL_MS = 10_000;

/** Whether a forced read may run: `undefined` when it may, otherwise the whole
 *  seconds until it can. A read that failed consumed no provider quota, so a
 *  tap recovering from an error is never held back. */
export function forcedReadWait(lastForcedAt: number, lastFailed: boolean, nowMs: number): number | undefined {
    if (lastFailed) return undefined;
    const remaining = FORCED_MIN_INTERVAL_MS - (nowMs - lastForcedAt);
    return remaining > 0 ? Math.ceil(remaining / 1_000) : undefined;
}
