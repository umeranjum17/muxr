#!/usr/bin/env node
// Home "Right now" line: the tightest plan limit and its reset, with the
// machine vitals folded underneath. Reads the usage RPC's on-disk cache via
// usage.mjs itself, so the identity, TTL and provider selection stay in one
// place: a warm cache returns instantly, a cold one falls back after a
// bounded wait so the vitals line below is never withheld.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { vitalsLine } from './vitals.mjs';

function nowLine(limits) {
  const windows = Array.isArray(limits?.windows)
    ? limits.windows.filter((window) => Number.isFinite(window?.used))
    : [];
  if (windows.length === 0) {
    return typeof limits?.message === 'string' && limits.message !== ''
      ? limits.message
      : 'Plan limits aren’t connected in muxr';
  }
  const tightest = windows.reduce((leading, window) => (window.used > leading.used ? window : leading));
  const label = typeof tightest.label === 'string' && tightest.label !== ''
    ? tightest.label
    : 'Current limit';
  const reset = typeof tightest.resetsIn === 'string' && tightest.resetsIn !== ''
    ? ` · resets in ${tightest.resetsIn}`
    : '';
  return `${label} ${Math.round(tightest.used)}%${reset}`;
}

const usage = fileURLToPath(new URL('./usage.mjs', import.meta.url));
let headline = 'Usage is being collected · try again shortly';
try {
  const collected = spawnSync(process.execPath, [usage], {
    input: '{}',
    timeout: 5_000,
    maxBuffer: 1024 * 1024,
    encoding: 'utf8',
  });
  if (collected.error === undefined && collected.status === 0) {
    headline = nowLine(JSON.parse(collected.stdout).limits);
  }
} catch {}
process.stdout.write(JSON.stringify(`${headline}\n${vitalsLine()}`));
