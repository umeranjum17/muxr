#!/usr/bin/env node
// Home "Right now" card payload: the tightest plan limit, the host's
// no-windows message, and machine vitals as figures. Reads the usage RPC's
// on-disk cache via usage.mjs itself, so the identity, TTL and provider
// selection stay in one place: a warm cache returns instantly, a cold one
// falls back after a bounded wait — `collecting` — so the vitals below are
// never withheld. The phone formats; this only decides facts.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { vitalsFigures } from './vitals.mjs';

/** The tightest window: highest share used, ties by soonest reset. Reads the
 *  same `limits` payload the Usage screen shows; `vms` is its parallel
 *  window list and carries resetEpochSec, which the bounded payload drops. */
function limitOf(limits, vms) {
    const windows = Array.isArray(limits?.windows) ? limits.windows : [];
    if (windows.length === 0) return undefined;
    const resetOf = (index) => {
        const vm = Array.isArray(vms) ? vms[index] : undefined;
        return Number.isFinite(vm?.resetEpochSec) ? vm.resetEpochSec : Number.POSITIVE_INFINITY;
    };
    let leading = 0;
    for (let index = 1; index < windows.length; index += 1) {
        if (windows[index].used > windows[leading].used
            || (windows[index].used === windows[leading].used && resetOf(index) < resetOf(leading))) leading = index;
    }
    const window = windows[leading];
    if (!Number.isFinite(window?.used)) return undefined;
    return {
        verdict: typeof limits.verdict === 'string' ? limits.verdict : 'unknown',
        label: typeof window.label === 'string' ? window.label : '',
        used: Math.round(window.used),
        ...(typeof window.resetsIn === 'string' && window.resetsIn !== '' ? { resetsIn: window.resetsIn } : {}),
        ...(Number.isFinite(window.elapsed) ? { elapsed: window.elapsed } : {}),
    };
}

const usage = fileURLToPath(new URL('./usage.mjs', import.meta.url));
let output;
try {
    const collected = spawnSync(process.execPath, [usage], {
        input: '{}',
        timeout: 5_000,
        maxBuffer: 1024 * 1024,
        encoding: 'utf8',
    });
    if (collected.error === undefined && collected.status === 0) output = JSON.parse(collected.stdout);
} catch {}
const limit = limitOf(output?.limits, output?.windows);
const payload = {
    ...(limit === undefined ? {} : { limit }),
    ...(limit === undefined && typeof output?.limits?.message === 'string'
        ? { message: output.limits.message.slice(0, 160) }
        : {}),
    ...(output === undefined ? { collecting: true } : {}),
    vitals: vitalsFigures(),
};
process.stdout.write(JSON.stringify(payload));
