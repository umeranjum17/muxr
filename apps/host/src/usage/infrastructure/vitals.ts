/** Machine vitals as figures, not prose: bytes and seconds, the phone owns
 *  units. A filesystem this host cannot stat omits the disk pair, so the
 *  phone drops that one figure and still shows memory, load and uptime. */
import { statfsSync } from 'node:fs';
import { freemem, loadavg, totalmem, uptime } from 'node:os';
import type { UsageVitals } from '@muxr/contract';

export function vitalsFigures(): UsageVitals {
    const memoryTotal = totalmem();
    let disk: { diskUsed: number; diskTotal: number } | undefined;
    try {
        // df's accounting: the root-reserved blocks `bfree` counts but
        // `bavail` withholds stay out of the capacity, so the share matches
        // the Use% a shell reports.
        const { blocks, bsize, bfree, bavail } = statfsSync('/');
        disk = { diskUsed: (blocks - bfree) * bsize, diskTotal: (blocks - bfree + bavail) * bsize };
    } catch { /* the disk pair is the one figure a host may not read */ }
    return {
        memoryUsed: memoryTotal - freemem(),
        memoryTotal,
        ...(disk === undefined ? {} : disk),
        load1: loadavg()[0] ?? 0,
        uptimeSeconds: Math.floor(uptime()),
    };
}
