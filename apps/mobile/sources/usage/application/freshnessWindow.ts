/** How long a collected reading stays good enough to show as it is, on both
 *  the Home card and the Usage screen: quota windows move over hours, so
 *  within this the figures are the answer and asking again costs a full
 *  collection for nothing. Past it a read asks the host to collect again
 *  rather than be served the same payload -- the usage cache answers with any
 *  same-day payload, so nothing else makes figures a reader can see are old
 *  become current. Doubles as the refresh cadence on both surfaces. */
export const FRESH_MS = 15 * 60_000;
