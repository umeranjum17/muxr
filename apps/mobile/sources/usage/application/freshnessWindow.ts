import type { UsageNow } from '@muxr/contract';
import { getCachedConnectionSettings } from '@/connection';

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

/** A key for anything the phone remembers about a tab. What one machine reports
 *  is not evidence about another, so the record and the reading below are kept
 *  per machine as well as per tab: switching machines must not let one
 *  machine's window hold back the other's first ask, nor paint its figures. */
export function machineKey(provider: string): string {
    return `${getCachedConnectionSettings().machineId}\u0000${provider}`;
}

/** When we last asked the host for a whole collection, per machine and tab: our
 *  own record of our own act of asking, on our own clock. The age of the
 *  reading that came back cannot stand in for this -- a host that cannot
 *  persist a reading (its limits or local activity unavailable) keeps serving
 *  the same old one, so its age never advances and the window would never
 *  close, and a host that reports no age at all would never open it. Module
 *  level, so a remount and a return from the foreground do not forget it. */
const askedAt = new Map<string, number>();

/** The last payload we were served for a machine and tab: the other half of the
 *  same memory, so a surface that remounts inside the window paints what it
 *  held instead of waiting a round trip. In memory only, and with the record's
 *  lifetime. */
const lastReading = new Map<string, UsageNow>();

/** Whether this machine's tab may be asked for a collection at `nowMs`: our own
 *  window has passed since we last asked, or we have never asked. Decided from
 *  when we asked, never from what the host answered -- and recorded against the
 *  same instant by `noteAsked`, so a cadence measures a whole window from where
 *  it decided rather than from a round trip. It gates the collection and
 *  nothing else: the read itself is never held back. */
export function collectionDue(provider: string, nowMs: number): boolean {
    const last = askedAt.get(machineKey(provider));
    return last === undefined || nowMs - last >= FRESH_MS - WINDOW_SLACK_MS;
}

/** Note that we asked for this machine's tab at `nowMs`, opening a new window. */
export function noteAsked(provider: string, nowMs: number): void {
    askedAt.set(machineKey(provider), nowMs);
}

/** Keep the payload this machine's tab was served, for the next mount. */
export function rememberReading(provider: string, value: UsageNow): void {
    lastReading.set(machineKey(provider), value);
}

/** What this machine's tab was last served, if anything. */
export function lastKnownReading(provider: string): UsageNow | undefined {
    return lastReading.get(machineKey(provider));
}
