/** How long a collected reading stays good enough to show as it is, on both
 *  the Home card and the Usage screen: quota windows move over hours, so
 *  within this the figures are the answer and asking again costs a full
 *  collection for nothing. Past it a read asks the host to collect again
 *  rather than be served the same payload -- the usage cache answers with any
 *  same-day payload, so nothing else makes figures a reader can see are old
 *  become current. Doubles as the refresh cadence on both surfaces. */
export const FRESH_MS = 15 * 60_000;

/** When we last asked the host for a whole collection, per tab: our own record
 *  of our own act of asking, on our own clock. The age of the reading that
 *  came back cannot stand in for this -- a host that cannot persist a reading
 *  (its limits or local activity unavailable) keeps serving the same old one,
 *  so its age never advances and the window would never close. Module level,
 *  so a remount and a return from the foreground do not forget it. */
const askedAt = new Map<string, number>();

/** Whether this tab may be asked for a collection again: our own window has
 *  passed since we last asked, and the reading we hold is old enough to be
 *  worth one. The window is the bound -- the reading's age can only hold an ask
 *  back, never cause one. */
export function collectionDue(provider: string, readingAgeSeconds: number | undefined, nowMs: number): boolean {
    const last = askedAt.get(provider);
    const windowPassed = last === undefined || nowMs - last >= FRESH_MS;
    return windowPassed && readingAgeSeconds !== undefined && readingAgeSeconds * 1_000 >= FRESH_MS;
}

/** Note that we asked for this tab, opening a new window. */
export function noteAsked(provider: string, nowMs: number): void {
    askedAt.set(provider, nowMs);
}
