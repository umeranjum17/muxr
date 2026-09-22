/**
 * Reset clock formatting and published window lengths for the Usage screen.
 */

/** Known window lengths in minutes. Rolling has no published length, so it
 * stays unknown and its rows never claim a projection. */
export const WINDOW_MINUTES = {
    five_hour: 5 * 60,
    seven_day: 7 * 24 * 60,
    weekly: 7 * 24 * 60,
    monthly: 30 * 24 * 60,
} as const;

function resetTimeMs(resetEpochSec: number | undefined, nowMs: number): number | undefined {
    if (!Number.isFinite(resetEpochSec) || !Number.isFinite(nowMs)) return undefined;
    const at = resetEpochSec! * 1000;
    // Same plausibility window usage collection always applied: a reset more
    // than a day old or over a year out is a corrupt timestamp, not a clock.
    if (at < nowMs - 86_400_000 || at > nowMs + 366 * 86_400_000) return undefined;
    return at;
}

function sameLocalDay(aMs: number, bMs: number): boolean {
    const a = new Date(aMs);
    const b = new Date(bMs);
    return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

/** Reset as a clock ("2:30 PM", "Fri 2:30 PM" past today), never a duration. */
export function resetClock(resetEpochSec: number | undefined, nowMs: number): string {
    const at = resetTimeMs(resetEpochSec, nowMs);
    if (at === undefined) return '';
    const time = new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit' }).format(new Date(at));
    if (sameLocalDay(at, nowMs)) return time;
    const day = new Intl.DateTimeFormat('en-US', { weekday: 'short' }).format(new Date(at));
    return `${day} ${time}`;
}

