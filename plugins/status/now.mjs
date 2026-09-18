#!/usr/bin/env node
// Home "Right now" card payload: the tightest plan limit and machine vitals
// as figures; the phone owns every word. Reads the usage RPC's
// on-disk cache via usage.mjs itself, so the identity, TTL and provider
// selection stay in one place: a warm cache returns instantly, a cold one
// falls back after a bounded wait — `collecting` — so the vitals below are
// never withheld. The phone formats; this only decides facts.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { vitalsFigures } from './vitals.mjs';

/** The tightest window: highest share used, ties to the first published —
 *  the rule `limitsPayload` used to pick the window its verdict describes.
 *  Reads the same `limits` payload the Usage screen shows; `vms` is its
 *  parallel window list and carries the unrounded share, so the window this
 *  card labels is always the window the verdict is about. */
function limitOf(limits, vms) {
    const windows = Array.isArray(limits?.windows) ? limits.windows : [];
    if (windows.length === 0) return undefined;
    const shareOf = (index) => {
        const exact = Array.isArray(vms) ? vms[index]?.percentUsed : undefined;
        return Number.isFinite(exact) ? exact : windows[index].used;
    };
    let leading = 0;
    for (let index = 1; index < windows.length; index += 1) {
        if (shareOf(index) > shareOf(leading)) leading = index;
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
    ...(output === undefined ? { collecting: true } : {}),
    vitals: vitalsFigures(),
};
process.stdout.write(JSON.stringify(payload));
