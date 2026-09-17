#!/usr/bin/env node
import { statfsSync } from 'node:fs';
import { freemem, totalmem, loadavg, uptime } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const gb = (bytes) => `${(bytes / 1024 ** 3).toFixed(1)}G`;

export function vitalsLine() {
  const hours = Math.floor(uptime() / 3600);
  let disk = 'unknown';
  try {
    // df's accounting: capacity ignores the root-reserved blocks that `bfree`
    // counts but `bavail` does not, so the figures match what a shell reports.
    const { blocks, bsize, bfree, bavail } = statfsSync('/');
    const used = (blocks - bfree) * bsize;
    const free = bavail * bsize;
    disk = `${gb(used)} used of ${gb(blocks * bsize)} (${Math.round(used / (used + free) * 100)}%) · ${gb(free)} free`;
  } catch {}
  return `memory ${gb(totalmem() - freemem())} of ${gb(totalmem())} · load ${loadavg().map((n) => n.toFixed(2)).join(' ')} · up ${hours}h · disk ${disk}`;
}

// Importable: now.mjs folds this line into the home card. Only print when run
// as the vitals RPC entry itself.
if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.stdout.write(JSON.stringify(vitalsLine()));
}
