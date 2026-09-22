import type { UsageNow, UsageReport, UsageVitals } from '@muxr/contract';
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
 *  is not evidence about another, so the record and the display below are kept
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

/** The figures a surface can paint, tagged by the read that produced them: the
 *  card's usage.now carries the vitals the screen has no place for and the
 *  screen's usage.report carries the activity the card has no place for, so a
 *  reader paints the part it knows and says nothing about the rest. */
export type UsageFigures =
    | { kind: 'now'; value: UsageNow }
    | { kind: 'report'; value: UsageReport };

/** What the phone can show for a machine and tab, and all it can show: figures
 *  it holds, a read it has asked for and is waiting on, or a failure with the
 *  host's own reason. Three states and no fourth, so neither surface is ever
 *  left with an absence to interpret -- a blank card is the complaint this
 *  exists to answer, and each of the routes that produced one did it by
 *  treating an absent payload as nothing to render. */
export type UsageDisplay =
    | { status: 'figures'; at: number; figures: UsageFigures }
    | { status: 'waiting'; askedAt: number; vitals?: UsageVitals }
    | { status: 'unavailable'; reason: string; vitals?: UsageVitals };

const displays = new Map<string, UsageDisplay>();

/** Whether this machine's tab may be asked for a collection at `nowMs`: our own
 *  window has passed since we last asked, or we have never asked. Decided from
 *  when we asked, never from what the host answered -- and recorded against the
 *  same instant by `noteAsked`, so a cadence measures a whole window from where
 *  it decided rather than from a round trip. */
export function collectionDue(provider: string, nowMs: number): boolean {
    const last = askedAt.get(machineKey(provider));
    return last === undefined || nowMs - last >= FRESH_MS - WINDOW_SLACK_MS;
}

/** Note that we asked for this machine's tab at `nowMs`, opening a new window. */
export function noteAsked(provider: string, nowMs: number): void {
    askedAt.set(machineKey(provider), nowMs);
}

/** What this machine's tab shows, if anything has been asked for it yet. */
export function shownUsage(provider: string): UsageDisplay | undefined {
    return displays.get(machineKey(provider));
}

/** Remember what this machine's tab shows: the figures a read painted, the wait
 *  an ask left behind, or the failure one ended in. In memory only, with the
 *  ask record's lifetime, and the one thing both surfaces paint. */
export function rememberShown(provider: string, display: UsageDisplay): void {
    displays.set(machineKey(provider), display);
}
