#!/usr/bin/env node
import { execSync } from 'node:child_process';
import { freemem, totalmem, loadavg, uptime } from 'node:os';

const gb = (bytes) => `${(bytes / 1024 ** 3).toFixed(1)}G`;
const hours = Math.floor(uptime() / 3600);
let disk = 'unknown';
try {
  const [, size, used, free, percent] = execSync('df -h / | tail -1', { encoding: 'utf8' }).trim().split(/\s+/);
  disk = `${used} used of ${size} (${percent}) · ${free} free`;
} catch {}
process.stdout.write(JSON.stringify(
  `memory ${gb(totalmem() - freemem())} of ${gb(totalmem())} · load ${loadavg().map((n) => n.toFixed(2)).join(' ')} · up ${hours}h · disk ${disk}`,
));
