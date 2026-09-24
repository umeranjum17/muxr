/**
 * The Home "Right now" card payload: the limits vocabulary the Usage screen
 * already speaks, narrowed to the one window its verdict describes, plus
 * machine vitals as figures; the phone owns every word. A warm usage cache
 * answers instantly; a cold one gets a bounded wait -- `collecting` -- so the
 * vitals below are never withheld.
 */
import type { UsageNow, UsageReport } from '@muxr/contract';
import { NOT_CONNECTED_MESSAGE, tightestWindow } from '../domain/usageWindows.js';
import { collectUsage, lastKnownPlans } from './collectUsage.js';
import { vitalsFigures } from './vitals.js';

/** Past this the cold cache answers without its limit window and the vitals
 *  still stand; the collection keeps running and warms the cache behind it. */
const NOW_WAIT_MS = 5_000;
/** With a last good reading on disk there is no reason to hold the card on a
 *  slow collection: past this it paints that reading and says a refresh is
 *  running, and the next ask picks up the collection when it lands. */
const KNOWN_WAIT_MS = 1_500;

export async function usageNow(env: NodeJS.ProcessEnv = process.env, { refresh = false }: { refresh?: boolean } = {}): Promise<UsageNow> {
    let output: Pick<UsageReport, 'windows' | 'limits' | 'connected' | 'capturedAt' | 'readingsFrom'> | undefined;
    // A forced read re-collects past a still-valid cache: the cache serves any
    // same-day payload, so a reader looking at figures it can see are old has
    // no other way to make them current.
    const collection = collectUsage({ ...(refresh ? { refresh: true } : {}) }, env).catch(() => undefined);
    let known: ReturnType<typeof lastKnownPlans>;
    try { known = lastKnownPlans(env); } catch { known = undefined; }
    try {
        output = await Promise.race([
            collection,
            new Promise<undefined>((resolve) => { const timer = setTimeout(() => resolve(undefined), known === undefined ? NOW_WAIT_MS : KNOWN_WAIT_MS); timer.unref(); }),
        ]);
    } catch { output = undefined; }
    const refreshing = output === undefined && known !== undefined && !known.current;
    if (output === undefined && known !== undefined) output = known;
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
    const captured = output?.capturedAt;
    // The oldest reading shown is what the age speaks for.
    const capturedAt = Date.parse(output?.readingsFrom ?? captured ?? '');
    const ageSeconds = Number.isFinite(capturedAt) ? Math.max(0, Math.round((Date.now() - capturedAt) / 1000)) : undefined;
    return {
        limits: {
            verdict: typeof output?.limits?.verdict === 'string' ? output.limits.verdict : 'unknown',
            windows: window === undefined ? [] : [window],
            ...(typeof reason === 'string' && reason !== '' && reason !== NOT_CONNECTED_MESSAGE ? { message: reason } : {}),
        },
        // One compact entry per provider with real quota windows, passed through
        // verbatim: the Home card's connected strip reads it, and the phone bounds
        // it at its own RPC boundary.
        ...(output?.connected === undefined ? {} : { connected: output.connected }),
        ...(output === undefined ? { collecting: true as const } : {}),
        ...(refreshing ? { refreshing: true as const } : {}),
        // How old the limit figures are, not whether some other surface would call
        // them stale: the usage cache replays its original `capturedAt`, and both
        // timestamps come from this host's clock. Each reader owns its own
        // threshold for when age is worth mentioning.
        ...(ageSeconds === undefined ? {} : { ageSeconds }),
        // The same instant by name, so a reader can tell the replayed cache entry
        // from a collection that has just landed without inferring it from the
        // age it was given.
        ...(captured === undefined ? {} : { capturedAt: captured }),
        vitals: vitalsFigures(),
    };
}
