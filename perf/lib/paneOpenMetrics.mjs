/**
 * Pure reductions for one measured transition. No adb: the probe captures the
 * dumps and the two `/proc` reads, and this turns them into the numbers.
 *
 * Both reductions fail loud rather than quiet. A window nobody could measure
 * reports why it could not be measured, because the failure modes here all look
 * like good news otherwise: a dead runtime reads as no CPU, an empty frame
 * window reads as no jank, and a restart mid-window reads as a huge idle gap.
 */

import { frameStatsRead } from './gestureMetrics.mjs';

/**
 * JS-thread busy share between two `/proc/<pid>/task/<tid>/stat` reads.
 * `hz` is USER_HZ, 100 on every Android build this runs on.
 */
export function threadBusyShare(open, close, hz = 100) {
    if (open?.unavailable !== undefined) return { unavailable: open.unavailable };
    if (close?.unavailable !== undefined) return { unavailable: close.unavailable };
    if (open === undefined || close === undefined) return { unavailable: 'the window was never opened or never closed' };
    // A restarted runtime resets its tick counter, so the difference would read
    // as an idle window rather than as the crash it was.
    if (close.pid !== open.pid || close.tid !== open.tid) return { unavailable: 'the runtime restarted inside the window' };
    const windowSeconds = (close.atMs - open.atMs) / 1000;
    if (!(windowSeconds > 0)) return { unavailable: 'the window had no duration' };
    const ticks = close.ticks - open.ticks;
    if (ticks < 0) return { unavailable: 'the tick counter went backwards' };
    return { percent: +((ticks / hz / windowSeconds) * 100).toFixed(1), windowSeconds: +windowSeconds.toFixed(2) };
}

/**
 * gfxinfo's own counters for the window. The percentiles come from the dump and
 * not from the framestats ring, because `parseJankDump` already refuses the
 * 4950 ms sentinel dumpsys writes into every percentile of an empty histogram:
 * a window that drew nothing is reported as having drawn nothing, never as one
 * slow frame. The ring is carried alongside only to say whether it was read at
 * all, since an unread ring and an empty one otherwise look identical.
 */
export function transitionFrameSummary(snapshot, hz) {
    const jank = snapshot?.jank ?? {};
    if (jank.frames === undefined || jank.frames === 0) {
        return { unavailable: 'no frames in the window; nothing was drawn to judge' };
    }
    return {
        frames: jank.frames,
        janky: jank.janky ?? null,
        jankyPercent: jank.jankyPercent ?? null,
        missedVsync: jank.missedVsync ?? null,
        deadlineMissed: jank.deadlineMissed ?? null,
        overOneFrame: jank.overOneFrame,
        overFourFrames: jank.overFourFrames,
        frameMs: { p50: jank.p50Ms ?? null, p90: jank.p90Ms ?? null, p95: jank.p95Ms ?? null, p99: jank.p99Ms ?? null },
        refreshHz: hz,
        framestatsRingRead: frameStatsRead(snapshot?.rows),
        framestatsRows: (snapshot?.rows ?? []).length,
    };
}
