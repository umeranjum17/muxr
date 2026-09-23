import type { UsageConnectedProvider, UsageLimitsWindow, UsageVitals } from '@muxr/contract';
import { compactAge } from '@/utils/compactAge';

/** The Right now vitals line's figures: rounded shares, a one-decimal load
 *  and an uptime in the same compactAge voice the activity rows speak.
 *  Impossible figures (a zero ceiling would divide by zero) read as no
 *  vitals rather than as a fabricated percentage. */
export interface VitalsFacts {
    memoryPercent: number;
    diskPercent?: number;
    load: string;
    uptime: string;
}

export function vitalsFacts(vitals: UsageVitals): VitalsFacts | undefined {
    if (vitals.memoryTotal <= 0 || vitals.uptimeSeconds < 0 || !Number.isFinite(vitals.load1)) return undefined;
    const facts: VitalsFacts = {
        memoryPercent: share(vitals.memoryUsed, vitals.memoryTotal),
        load: Number(vitals.load1.toFixed(1)).toString(),
        uptime: compactAge(vitals.uptimeSeconds * 1_000),
    };
    const disk = diskShare(vitals);
    return disk === undefined ? facts : { ...facts, diskPercent: disk };
}

function diskShare(vitals: UsageVitals): number | undefined {
    if (vitals.diskUsed === undefined || vitals.diskTotal === undefined || vitals.diskTotal <= 0) return undefined;
    return share(vitals.diskUsed, vitals.diskTotal);
}

/** A share of something cannot exceed it; a host that says otherwise is
 *  bounded here rather than printed. */
const share = (used: number, total: number): number =>
    Math.min(100, Math.max(0, Math.round((used / total) * 100)));

/** At or below this share left a limit is close enough to its ceiling to be
 *  worth the eye. Presentation only: what a window means is the host's call. */
const LOW_LEFT = 15;

/** Low is a warning; nothing left, or a plan already refusing work, is danger. */
export type LimitTone = 'warning' | 'danger';

/** One figure on the Right now card: what is left of one window. */
export interface LimitCell {
    window: UsageLimitsWindow;
    /** Whole percent left, 0..100. */
    left: number;
    /** Absent while there is plenty left: the card stays monochrome until a
     *  limit is actually low. */
    tone?: LimitTone;
}

/** One plan's column: its cells line up with the grid's rows. A row this
 *  plan has no limit for has an empty cell. */
export interface LimitColumn {
    provider: UsageConnectedProvider;
    cells: LimitCell[][];
}

/**
 * Every connected plan's limits as one grid: a row per window length, shortest
 * first (unknown lengths last); a column per plan, in name order, so a plan
 * keeps its place however its figures move and the eye learns where to look.
 */
export interface LimitGrid {
    /** Each row's name, the one the card prints beside it ("5h", "7d", "Monthly"). */
    rows: string[];
    columns: LimitColumn[];
}

export function limitGrid(providers: readonly UsageConnectedProvider[]): LimitGrid {
    // A share that is not a number is not a reading: dropped here rather than
    // printed as one. A plan left with nothing readable has nothing to show.
    const readable = providers
        .map((provider) => ({ provider, windows: provider.windows.filter((window) => Number.isFinite(window.used)) }))
        .filter(({ windows }) => windows.length > 0)
        .sort((a, b) => a.provider.label.localeCompare(b.provider.label));
    // Rows by length; a window with no published length (a billing month) sorts
    // after every one that has one, and ties keep the order they first appear.
    const rows = [...new Set(readable.flatMap(({ windows }) => windows.map(rowName)))]
        .sort((a, b) => {
            const [x, y] = [lengthInMinutes(a), lengthInMinutes(b)];
            return x === y ? 0 : x - y;
        });
    const columns = readable.map(({ provider, windows }) => ({
        provider,
        cells: rows.map((row) => windows
            .filter((window) => rowName(window) === row)
            .map(limitCell)
            .sort((a, b) => a.left - b.left)),
    }));
    return { rows, columns };
}

function limitCell(window: UsageLimitsWindow): LimitCell {
    const left = Math.min(100, Math.max(0, 100 - Math.round(window.used)));
    const tone = limitTone(window, left);
    return tone === undefined ? { window, left } : { window, left, tone };
}

/** Tone follows what is left, not the pace verdict: a month with no published
 *  length has no pace, and is no less empty for it. */
function limitTone(window: UsageLimitsWindow, left: number): LimitTone | undefined {
    if (left === 0 || window.pace === 'limited') return 'danger';
    if (left <= LOW_LEFT) return 'warning';
    return undefined;
}

/** The shortest name that still says which window a figure belongs to. */
function rowName(window: UsageLimitsWindow): string {
    return window.window ?? window.label;
}

const MINUTES: Record<string, number> = { m: 1, h: 60, d: 1_440 };

function lengthInMinutes(name: string): number {
    const match = /^(\d+)([mhd])$/.exec(name);
    return match === null ? Number.POSITIVE_INFINITY : Number(match[1]) * MINUTES[match[2]!]!;
}

/** How many plan columns a band holds when `fits` fit across the card: as many
 *  as fit, spread evenly over as few bands as that takes, so four plans that
 *  fit three to a row read as two and two rather than three and a straggler. */
export function columnsPerBand(count: number, fits: number): number {
    const bands = Math.ceil(count / Math.max(1, fits));
    return Math.max(1, Math.ceil(count / Math.max(1, bands)));
}
