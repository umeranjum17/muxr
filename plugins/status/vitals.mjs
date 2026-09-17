#!/usr/bin/env node
import { statfsSync } from 'node:fs';
import { freemem, totalmem, loadavg, uptime } from 'node:os';
import { fileURLToPath } from 'node:url';

/** Machine vitals as figures, not prose: bytes and seconds, the phone owns
 *  units. Failed statfs leaves the disk pair at zero, which the phone's
 *  bounded parser treats as "no vitals line" rather than guessing. */
export function vitalsFigures() {
    const memoryTotal = totalmem();
    let diskUsed = 0;
    let diskTotal = 0;
    try {
        // df's accounting: capacity counts the root-reserved blocks that
        // `bfree` includes, so the share matches what a shell reports.
        const { blocks, bsize, bfree } = statfsSync('/');
        diskUsed = (blocks - bfree) * bsize;
        diskTotal = blocks * bsize;
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
