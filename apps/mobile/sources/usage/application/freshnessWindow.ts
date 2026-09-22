/** How long a collected reading stays good enough to show as it is, on both
 *  the Home card and the Usage screen: quota windows move over hours, so
 *  within this the figures are the answer and asking again costs a full
 *  collection for nothing. Past it a read asks the host to collect again
 *  rather than be served the same payload -- the usage cache answers with any
 *  same-day payload, so nothing else makes figures a reader can see are old
 *  become current. Doubles as the refresh cadence on both surfaces. */
export const FRESH_MS = 15 * 60_000;

/** Whether a reading is old enough to be worth a whole collection. One rule,
 *  on the phone's window, for every surface: the host's own staleness flag
 *  says the figures are ageing, but it must not decide this, or each surface
 *  ends up collecting on a different clock. */
export function pastFreshnessWindow(ageSeconds: number | undefined): boolean {
    return ageSeconds !== undefined && ageSeconds * 1_000 >= FRESH_MS;
}
