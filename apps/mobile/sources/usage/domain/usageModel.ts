import type { UsageVitals } from '@muxr/contract';
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
