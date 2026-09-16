/**
 * Rate-limit headroom math for the Usage screen. Pure and side-effect free so
 * the pace boundaries stay testable without stubbing provider backends.
 *
 * One rule owns every colour: red fires only when the current burn projects
 * past the limit before the reset clock, never merely for crossing a percent.
 * Without a usable reset or window length there is no projection to stand on,
 * so the tone caps at amber and the verdict stays neutral.
 */

/** Known window lengths in minutes. Rolling has no published length, so it
 * stays unknown and its rows never claim a projection. */
export const WINDOW_MINUTES = {
  five_hour: 5 * 60,
  seven_day: 7 * 24 * 60,
  weekly: 7 * 24 * 60,
  monthly: 30 * 24 * 60,
};

/** A projection needs a visible burn: under 5% of the window elapsed the rate
 * is noise, so the row reports neutral instead of crying burning. */
const MIN_ELAPSED_SHARE = 0.05;
/** Projected share of the window that reads as tight but survivable. */
const TIGHT_PROJECTED = 70;
/** Remaining headroom that reads as tight when no projection is possible. */
const TIGHT_REMAINING = 15;

function resetTimeMs(resetEpochSec, nowMs) {
  if (!Number.isFinite(resetEpochSec) || !Number.isFinite(nowMs)) return undefined;
  const at = resetEpochSec * 1000;
  // Same plausibility window usage.mjs always applied: a reset more than a
  // day old or over a year out is a corrupt timestamp, not a clock.
  if (at < nowMs - 86_400_000 || at > nowMs + 366 * 86_400_000) return undefined;
  return at;
}

function sameLocalDay(aMs, bMs) {
  const a = new Date(aMs);
  const b = new Date(bMs);
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

/** Reset as a clock ("2:30 PM", "Fri 2:30 PM" past today), never a duration. */
export function resetClock(resetEpochSec, nowMs) {
  const at = resetTimeMs(resetEpochSec, nowMs);
  if (at === undefined) return '';
  const time = new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit' }).format(new Date(at));
  if (sameLocalDay(at, nowMs)) return time;
  const day = new Intl.DateTimeFormat('en-US', { weekday: 'short' }).format(new Date(at));
  return `${day} ${time}`;
}

/**
 * Plain-language pace verdict the data supports. `used` is 0-100, `limited`
 * marks a provider-reported rate-limited window, `windowMinutes` may be
 * undefined when the provider publishes no usable length.
 */
export function paceVerdict({ used, windowMinutes, resetEpochSec, nowMs, limited = false }) {
  const remaining = 100 - used;
  if (limited && remaining > 0) return { verdict: 'limited', tone: 'danger' };
  if (remaining <= 0) return { verdict: 'exhausted', tone: 'danger' };
  const at = resetTimeMs(resetEpochSec, nowMs);
  const remainingMin = at === undefined ? undefined : (at - nowMs) / 60_000;
  if (
    at === undefined || remainingMin === undefined || remainingMin <= 0
    || !Number.isFinite(windowMinutes) || windowMinutes <= 0
  ) {
    return remaining <= TIGHT_REMAINING
      ? { verdict: 'on pace', tone: 'warning' }
      : { verdict: 'on pace', tone: 'positive' };
  }
  const elapsedMin = windowMinutes - remainingMin;
  if (elapsedMin < windowMinutes * MIN_ELAPSED_SHARE) {
    return remaining <= TIGHT_REMAINING
      ? { verdict: 'on pace', tone: 'warning' }
      : { verdict: 'ahead', tone: 'positive' };
  }
  const projected = used / elapsedMin * windowMinutes;
  if (projected >= 100) return { verdict: 'burning', tone: 'danger' };
  if (projected >= TIGHT_PROJECTED) return { verdict: 'on pace', tone: 'warning' };
  return { verdict: 'ahead', tone: 'positive' };
}

/**
 * One uniform rate-limit row: headroom first, then the reset clock and the
 * pace word. Fits the bar-chart `detail` slot (≤24 bytes) the manifest binds.
 */
export function limitRow({ label, used, windowMinutes, resetEpochSec, nowMs, limited = false }) {
  const remaining = Math.max(0, Math.min(100, 100 - used));
  const { verdict, tone } = paceVerdict({ used, windowMinutes, resetEpochSec, nowMs, limited });
  const clock = resetClock(resetEpochSec, nowMs);
  const full = `${clock} · ${verdict}`;
  return {
    label,
    value: remaining,
    valueLabel: `${Math.round(remaining)}% left`,
    tone,
    ...(clock === '' || Buffer.byteLength(full, 'utf8') > 24 ? { detail: verdict } : { detail: full }),
  };
}

/** Headline form for the Claude progress rows, which have no detail slot. */
export function headroomLabel({ used, windowMinutes, resetEpochSec, nowMs, limited = false }) {
  const remaining = Math.max(0, Math.min(100, 100 - used));
  const { verdict } = paceVerdict({ used, windowMinutes, resetEpochSec, nowMs, limited });
  const clock = resetClock(resetEpochSec, nowMs);
  return `${Math.round(remaining)}% left · ${verdict}${clock === '' ? '' : ` · ${clock}`}`;
}
