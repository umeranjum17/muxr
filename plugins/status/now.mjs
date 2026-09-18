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
import { NOT_CONNECTED_MESSAGE, tightestWindow } from './usageWindows.mjs';
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
// `windows` is the unrounded view-model list `limitsPayload` derived the
// verdict from, parallel to the rendered `limits.windows`. Running the same
// selection over it is what keeps the window the card labels and the window
// the verdict describes one window.
const vms = Array.isArray(output?.windows) ? output.windows : [];
const published = Array.isArray(output?.limits?.windows) ? output.limits.windows : [];
const tightest = tightestWindow(vms);
const window = tightest === undefined ? undefined : published[vms.indexOf(tightest)];
// The provider's own reason for having no limits -- expired token, plan read
// unavailable -- is the actionable word. Only the generic no-integration line
// is withheld, because the card owns a localized one.
const reason = output?.limits?.message;
const payload = {
    limits: {
        verdict: typeof output?.limits?.verdict === 'string' ? output.limits.verdict : 'unknown',
        windows: window === undefined ? [] : [window],
        ...(typeof reason === 'string' && reason !== '' && reason !== NOT_CONNECTED_MESSAGE ? { message: reason } : {}),
    },
    ...(output === undefined ? { collecting: true } : {}),
    // The usage cache answers instantly past its fresh window rather than
    // making the card wait; say so, so figures that old are not read as live.
    ...(output?.stale === true ? { stale: true } : {}),
    vitals: vitalsFigures(),
};
process.stdout.write(JSON.stringify(payload));
