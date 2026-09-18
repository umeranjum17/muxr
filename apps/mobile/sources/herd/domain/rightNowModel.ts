import { MAX_CHART_LABEL_BYTES, capUtf8Bytes, sanitizeDisplayText } from '@muxr/contract';
import type { PluginDataCard, PluginManifestV1 } from '@muxr/contract';

/** What the host says about right now: the tightest plan limit and machine
 *  vitals as figures. The phone owns units and every word. */
export type RightNowVerdict = 'go' | 'ahead' | 'watch' | 'low' | 'limited' | 'unknown';

export interface RightNowLimit {
    verdict: RightNowVerdict;
    label: string;
    /** Percent of the window used, 0..100. */
    used: number;
    /** Duration until reset ("4d 17h"); omitted when the host has none. */
    resetsIn?: string;
    /** How much of the window has elapsed, 0..1, when the length is known. */
    elapsed?: number;
}

export interface RightNowVitals {
    memoryUsed: number;
    memoryTotal: number;
    diskUsed: number;
    diskTotal: number;
    load1: number;
    uptimeSeconds: number;
}

export interface RightNowPayload {
    limit?: RightNowLimit;
    /** Cold usage cache; the host fell back so the vitals could answer. */
    collecting?: true;
    vitals?: RightNowVitals;
}

const VERDICTS = new Set<Exclude<RightNowVerdict, 'unknown'>>(['go', 'ahead', 'watch', 'low', 'limited']);

const bounded = (value: unknown, bytes: number): string =>
    typeof value === 'string' ? capUtf8Bytes(sanitizeDisplayText(value).trim(), bytes) : '';

const finiteIn = (value: unknown, low: number, high: number): value is number =>
    typeof value === 'number' && Number.isFinite(value) && value >= low && value <= high;

/** The vitals line's figures: rounded shares, a one-decimal load and an
 *  uptime in the compactAge voice (under a day in hours, then days). */
export function vitalsFacts(vitals: RightNowVitals): { memoryPercent: number; diskPercent: number; load: string; uptime: string } {
    const hours = Math.floor(vitals.uptimeSeconds / 3600);
    return {
        memoryPercent: Math.round((vitals.memoryUsed / vitals.memoryTotal) * 100),
        diskPercent: Math.round((vitals.diskUsed / vitals.diskTotal) * 100),
        load: Number(vitals.load1.toFixed(1)).toString(),
        uptime: hours < 24 ? `${hours}h` : `${Math.floor(hours / 24)}d`,
    };
}

/** Bound untrusted RPC data before it reaches the app-owned card. Any parse
 *  failure drops the piece it hit — never a crash, never raw JSON. */
export function asRightNowPayload(value: unknown): RightNowPayload {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
    const raw = value as Record<string, unknown>;
    let limit: RightNowLimit | undefined;
    if (typeof raw.limit === 'object' && raw.limit !== null && !Array.isArray(raw.limit)) {
        const window = raw.limit as Record<string, unknown>;
        const verdict = typeof window.verdict === 'string' && VERDICTS.has(window.verdict as Exclude<RightNowVerdict, 'unknown'>)
            ? window.verdict as RightNowVerdict
            : 'unknown';
        const label = bounded(window.label, MAX_CHART_LABEL_BYTES);
        // A limit without a usable share of a named window is dropped, not guessed.
        if (label !== '' && finiteIn(window.used, 0, 100)) {
            const resetsIn = bounded(window.resetsIn, MAX_CHART_LABEL_BYTES);
            limit = {
                verdict,
                label,
                used: window.used,
                ...(resetsIn === '' ? {} : { resetsIn }),
                ...(finiteIn(window.elapsed, 0, 1) ? { elapsed: window.elapsed } : {}),
            };
        }
    }
    const vitals = rightNowVitals(raw.vitals);
    return {
        ...(limit === undefined ? {} : { limit }),
        ...(raw.collecting === true ? { collecting: true as const } : {}),
        ...(vitals === undefined ? {} : { vitals }),
    };
}

function rightNowVitals(value: unknown): RightNowVitals | undefined {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
    const raw = value as Record<string, unknown>;
    const memoryUsed = raw.memoryUsed;
    const memoryTotal = raw.memoryTotal;
    const diskUsed = raw.diskUsed;
    const diskTotal = raw.diskTotal;
    const load1 = raw.load1;
    const uptimeSeconds = raw.uptimeSeconds;
    // Every figure finite and non-negative, and a zero ceiling would make the
    // shares divide by zero — one bad number drops the whole line.
    const usable = typeof memoryTotal === 'number' && memoryTotal > 0
        && typeof diskTotal === 'number' && diskTotal > 0
        && [memoryUsed, memoryTotal, diskUsed, diskTotal, load1, uptimeSeconds]
            .every((figure) => typeof figure === 'number' && Number.isFinite(figure) && figure >= 0);
    if (!usable) return undefined;
    return { memoryUsed, memoryTotal, diskUsed, diskTotal, load1, uptimeSeconds } as RightNowVitals;
}

export interface RightNowBinding {
    pluginId: string;
    manifestHash: string;
    /** The data-card's own id, so the generic Home row skips exactly this
     *  card and still draws every other plugin's. */
    cardId: string;
    contributionId: string;
    contentContributionId?: string;
}

/** The `home.cards` data-card whose source is a plugin's `now` rpc is the
 *  product's Right now card: the declarative placement decides both that the
 *  product component draws it and that the generic DataCard skips it. One
 *  binding, read by both sides, so the two can never disagree. */
export function rightNowBinding(
    plugins: readonly { summary: { pluginId: string; manifestHash: string }; manifest: PluginManifestV1 }[],
): RightNowBinding | undefined {
    for (const { summary, manifest } of plugins) {
        for (const contribution of manifest.contributions) {
            if (!('type' in contribution) || contribution.type !== 'data-card' || contribution.slot !== 'home.cards') continue;
            if (!sourcedFromNow(manifest, contribution)) continue;
            return {
                pluginId: summary.pluginId,
                manifestHash: summary.manifestHash,
                cardId: contribution.id,
                contributionId: contribution.source.contributionId,
                ...(contribution.contentContributionId === undefined ? {} : { contentContributionId: contribution.contentContributionId }),
            };
        }
    }
    return undefined;
}

function sourcedFromNow(manifest: PluginManifestV1, contribution: PluginDataCard): boolean {
    return manifest.contributions.some((candidate) =>
        candidate.slot === 'host.rpc' && candidate.method === 'now' && candidate.id === contribution.source.contributionId);
}
