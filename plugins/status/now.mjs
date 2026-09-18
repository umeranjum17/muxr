#!/usr/bin/env node
// Home "Right now" card payload: the limits vocabulary the Usage screen
// already speaks, narrowed to the one window its verdict describes, plus
// machine vitals as figures; the phone owns every word. Reads the usage RPC's
// on-disk cache via usage.mjs itself, so the identity, TTL and provider
// selection stay in one place: a warm cache returns instantly, a cold one
// falls back after a bounded wait — `collecting` — so the vitals below are
// never withheld. The phone formats; this only decides facts.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { vitalsFigures } from './vitals.mjs';

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
// `limitsPayload` publishes which window it derived the verdict from; reading
// that one decision is what keeps the window the card labels and the window
// the verdict describes the same window.
const published = Array.isArray(output?.limits?.windows) ? output.limits.windows : [];
const chosen = output?.limits?.verdictWindow;
const window = Number.isInteger(chosen) ? published[chosen] : undefined;
const payload = {
    limits: {
        verdict: typeof output?.limits?.verdict === 'string' ? output.limits.verdict : 'unknown',
        windows: window === undefined ? [] : [window],
    },
    ...(output === undefined ? { collecting: true } : {}),
    vitals: vitalsFigures(),
};
process.stdout.write(JSON.stringify(payload));
