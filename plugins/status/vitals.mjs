#!/usr/bin/env node
import { statfsSync } from 'node:fs';
import { freemem, totalmem, loadavg, uptime } from 'node:os';

/** Machine vitals as figures, not prose: bytes and seconds, the phone owns
 *  units. A filesystem this host cannot stat omits the disk pair, so the
 *  phone drops that one figure and still shows memory, load and uptime. */
export function vitalsFigures() {
    const memoryTotal = totalmem();
    let disk;
    try {
        // df's accounting: the root-reserved blocks `bfree` counts but
        // `bavail` withholds stay out of the capacity, so the share matches
        // the Use% a shell reports.
        const { blocks, bsize, bfree, bavail } = statfsSync('/');
        disk = { diskUsed: (blocks - bfree) * bsize, diskTotal: (blocks - bfree + bavail) * bsize };
    } catch {}
    return {
        memoryUsed: memoryTotal - freemem(),
        memoryTotal,
        ...disk,
        load1: loadavg()[0] ?? 0,
        uptimeSeconds: Math.floor(uptime()),
    };
}
