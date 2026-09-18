import { RIGHT_NOW_CARD_MIN_UI_VERSION, type PluginDataCard, type PluginManifestV1 } from '@muxr/contract';
import { asLimitsPayload, type PluginLimitsPayload } from '@/plugins/limits';
import { compactAge } from './agentPresentation';

/** What the host says about right now: the plan limits vocabulary the Usage
 *  screen already speaks, narrowed to the window its verdict describes, plus
 *  machine vitals as figures. The phone owns units and every word. */
export interface RightNowVitals {
    memoryUsed: number;
    memoryTotal: number;
    /** Omitted when the host could not read the filesystem; the other
     *  figures still answer. `diskTotal` is used + available, which is what
     *  df divides by for Use%, not the filesystem's raw capacity -- the
     *  root-reserved blocks are excluded. Read the pair as a share, never as
     *  "X of Y bytes". */
    diskUsed?: number;
    diskTotal?: number;
    load1: number;
    uptimeSeconds: number;
}

export interface RightNowPayload {
    limits: PluginLimitsPayload;
    /** Cold usage cache; the host fell back so the vitals could answer. */
    collecting?: true;
    /** How old the limit figures are, by the host's clock. The vitals beside
     *  them are always live. This surface decides for itself when an age is
     *  worth mentioning. */
    ageSeconds?: number;
    vitals?: RightNowVitals;
}

/** No machine has been up a century: past this the host is publishing a bad
 *  figure, not a fact, and an unbounded one renders in exponential notation.
 *  The age of the limit figures is spoken in the same voice, so it shares the
 *  ceiling. */
const MAX_UPTIME_SECONDS = 100 * 365 * 86_400;

/** A load average is runnable threads; a machine reporting four figures of
 *  them is reporting a bad figure, and `toFixed` would print it in
 *  exponential notation. */
const MAX_LOAD = 1024;

/** A share of something cannot exceed it; a host that says otherwise is
 *  bounded here rather than printed. */
const share = (used: number, total: number): number =>
    Math.min(100, Math.max(0, Math.round((used / total) * 100)));

/** The vitals line's figures: rounded shares, a one-decimal load and an
 *  uptime in the same compactAge voice the activity rows speak. */
export function vitalsFacts(vitals: RightNowVitals): { memoryPercent: number; diskPercent?: number; load: string; uptime: string } {
    const disk = vitals.diskUsed === undefined || vitals.diskTotal === undefined
        ? undefined
        : share(vitals.diskUsed, vitals.diskTotal);
    return {
        memoryPercent: share(vitals.memoryUsed, vitals.memoryTotal),
        ...(disk === undefined ? {} : { diskPercent: disk }),
        load: Number(vitals.load1.toFixed(1)).toString(),
        uptime: compactAge(vitals.uptimeSeconds * 1_000),
    };
}

/** Bound untrusted RPC data before it reaches the app-owned card. The limit
 *  half is the plugins context's own parser, so one bounding rule serves both
 *  the Usage screen and this card. */
export function asRightNowPayload(value: unknown): RightNowPayload {
    const raw = typeof value === 'object' && value !== null && !Array.isArray(value)
        ? value as Record<string, unknown>
        : {};
    const vitals = rightNowVitals(raw.vitals);
    const ageSeconds = figure(raw.ageSeconds, MAX_UPTIME_SECONDS);
    return {
        limits: asLimitsPayload(raw.limits),
        ...(raw.collecting === true ? { collecting: true as const } : {}),
        ...(ageSeconds === undefined ? {} : { ageSeconds }),
        ...(vitals === undefined ? {} : { vitals }),
    };
}

/** Every host figure this card renders is bounded here, at the one boundary
 *  the module owns, so the formatters below stay pure formatting. */
const figure = (candidate: unknown, max = Number.MAX_SAFE_INTEGER): number | undefined =>
    typeof candidate === 'number' && Number.isFinite(candidate) && candidate >= 0
        ? Math.min(candidate, max)
        : undefined;

function rightNowVitals(value: unknown): RightNowVitals | undefined {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
    const raw = value as Record<string, unknown>;
    const memoryUsed = figure(raw.memoryUsed);
    const memoryTotal = figure(raw.memoryTotal);
    const load1 = figure(raw.load1, MAX_LOAD);
    const uptimeSeconds = figure(raw.uptimeSeconds, MAX_UPTIME_SECONDS);
    // A zero ceiling would make the share divide by zero.
    if (memoryUsed === undefined || memoryTotal === undefined || memoryTotal === 0) return undefined;
    if (load1 === undefined || uptimeSeconds === undefined) return undefined;
    const diskUsed = figure(raw.diskUsed);
    const diskTotal = figure(raw.diskTotal);
    const disk = diskUsed === undefined || diskTotal === undefined || diskTotal === 0 ? undefined : { diskUsed, diskTotal };
    return { memoryUsed, memoryTotal, ...disk, load1, uptimeSeconds };
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

/** The inline `home.cards` data-card sourced from a plugin's `now` read rpc
 *  is the product's Right now card: the declarative placement decides both
 *  that the product component draws it and that the generic DataCard skips
 *  it. One binding, read by both sides, so the two can never disagree. */
export function rightNowBinding(
    plugins: readonly { summary: { pluginId: string; manifestHash: string }; manifest: PluginManifestV1 }[],
): RightNowBinding | undefined {
    for (const { summary, manifest } of plugins) {
        if ((manifest.minMuxrVersion ?? 1) < RIGHT_NOW_CARD_MIN_UI_VERSION) continue;
        for (const contribution of manifest.contributions) {
            if (!('type' in contribution) || contribution.type !== 'data-card') continue;
            if (contribution.slot !== 'home.cards' || contribution.presentation === 'sheet') continue;
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
        candidate.slot === 'host.rpc' && candidate.mode === 'read'
        && candidate.method === 'now' && candidate.id === contribution.source.contributionId);
}
