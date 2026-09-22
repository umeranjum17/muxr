/** How long a collected reading stays good enough to show as it is, on both
 *  the Home card and the Usage screen: quota windows move over hours, so
 *  within this the figures are the answer and asking again costs a full
 *  collection for nothing. Past it a read asks the host to collect again
 *  rather than be served the same payload -- the usage cache answers with any
 *  same-day payload, so nothing else makes figures a reader can see are old
 *  become current. Doubles as the refresh cadence on both surfaces. */
export const FRESH_MS = 15 * 60_000;

/** The slack the window comparison below carries. A cadence arms its timer
 *  before its own ask is recorded, and a timer fires a hair after the instant
 *  it was scheduled for, so a cycle measuring a whole window from the last ask
 *  misses it by microseconds and then waits out a second whole window. Under a
 *  second, this can never fit two collections into one window. */
const WINDOW_SLACK_MS = 1_000;

/** When we last asked the host for a whole collection, per tab: our own record
 *  of our own act of asking, on our own clock. The age of the reading that
 *  came back cannot stand in for this -- a host that cannot persist a reading
 *  (its limits or local activity unavailable) keeps serving the same old one,
 *  so its age never advances and the window would never close, and a host that
 *  reports no age at all would never open it. Module level, so a remount and a
 *  return from the foreground do not forget it. */
const askedAt = new Map<string, number>();

/** Whether this tab may be asked for a collection at `nowMs`: our own window
 *  has passed since we last asked, or we have never asked. Decided from when
 *  we asked, never from what the host answered -- and recorded against the same
 *  instant by `noteAsked`, so a cadence measures a whole window from where it
 *  decided rather than from a round trip. */
export function collectionDue(provider: string, nowMs: number): boolean {
    const last = askedAt.get(provider);
    return last === undefined || nowMs - last >= FRESH_MS - WINDOW_SLACK_MS;
}

/** Note that we asked for this tab at `nowMs`, opening a new window. */
export function noteAsked(provider: string, nowMs: number): void {
    askedAt.set(provider, nowMs);
}
