#!/usr/bin/env node
import { statfsSync } from 'node:fs';
import { freemem, totalmem, loadavg, uptime } from 'node:os';

/** Machine vitals as figures, not prose: bytes and seconds, the phone owns
 *  units. Failed statfs leaves the disk pair at zero, which the phone's
 *  bounded parser treats as "no vitals line" rather than guessing. */
export function vitalsFigures() {
    const memoryTotal = totalmem();
    let diskUsed = 0;
    let diskTotal = 0;
    try {
        // df's accounting: the root-reserved blocks `bfree` counts but
        // `bavail` withholds stay out of the capacity, so the share matches
        // the Use% a shell reports.
        const { blocks, bsize, bfree, bavail } = statfsSync('/');
        diskUsed = (blocks - bfree) * bsize;
        diskTotal = (blocks - bfree + bavail) * bsize;
    } catch {}
    return {
        memoryUsed: memoryTotal - freemem(),
        memoryTotal,
        diskUsed,
        diskTotal,
        load1: loadavg()[0] ?? 0,
        uptimeSeconds: Math.floor(uptime()),
    };
}
