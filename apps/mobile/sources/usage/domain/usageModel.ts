import type { UsageConnectedProvider, UsageLimitsWindow, UsageVitals } from '@trymuxr/contract';
import { compactAge } from '@/utils/compactAge';

/** The machine's figures behind Home's one word: rounded shares, a one-decimal
 *  load and an uptime in the same compactAge voice the activity rows speak.
 *  Impossible figures (a zero ceiling would divide by zero) read as no
 *  vitals rather than as a fabricated percentage. */
export interface VitalsFacts {
    /** Busy when memory is nearly full or the run queue reaches the core count; healthy only when the core count is known. */
    state?: 'healthy' | 'busy';
    memoryPercent: number;
    diskPercent?: number;
    load: string;
    uptime: string;
}

/** Memory share at which the machine counts as busy, whatever its load. */
const BUSY_MEMORY_PERCENT = 90;

export function vitalsFacts(vitals: UsageVitals): VitalsFacts | undefined {
    if (vitals.memoryTotal <= 0 || vitals.uptimeSeconds < 0 || !Number.isFinite(vitals.load1)) return undefined;
    const memoryPercent = share(vitals.memoryUsed, vitals.memoryTotal);
    const busy = memoryPercent >= BUSY_MEMORY_PERCENT || (vitals.cpus !== undefined && vitals.load1 >= vitals.cpus);
    const facts: VitalsFacts = {
        state: busy ? 'busy' : vitals.cpus === undefined ? undefined : 'healthy',
        memoryPercent,
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

export interface LimitFigure {
    name: string;
    cells: LimitCell[];
}

export interface LimitPlan {
    provider: UsageConnectedProvider;
    figures: LimitFigure[];
}

export function limitPlans(providers: readonly UsageConnectedProvider[]): LimitPlan[] {
    return providers.flatMap((provider) => {
        const groups = new Map<string, LimitCell[]>();
        for (const window of provider.windows) {
            if (!Number.isFinite(window.used)) continue;
            const name = window.window ?? window.label;
            const cells = groups.get(name) ?? [];
            cells.push(limitCell(window));
            groups.set(name, cells);
        }
        if (groups.size === 0) return [];
        const figures = [...groups].map(([name, cells]) => ({ name, cells: cells.sort((a, b) => a.left - b.left) }))
            .sort((a, b) => lengthInMinutes(a.name) - lengthInMinutes(b.name) || 0);
        return [{ provider, figures }];
    }).sort((a, b) => a.provider.label.localeCompare(b.provider.label));
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

const MINUTES: Record<string, number> = { m: 1, h: 60, d: 1_440 };

function lengthInMinutes(name: string): number {
    const match = /^(\d+)([mhd])$/.exec(name);
    return match === null ? Number.POSITIVE_INFINITY : Number(match[1]) * MINUTES[match[2]!]!;
}
