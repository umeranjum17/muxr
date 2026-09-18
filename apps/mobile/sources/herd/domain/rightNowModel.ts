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
     *  figures still answer. */
    diskUsed?: number;
    diskTotal?: number;
    load1: number;
    uptimeSeconds: number;
}

export interface RightNowPayload {
    limits: PluginLimitsPayload;
    /** Cold usage cache; the host fell back so the vitals could answer. */
    collecting?: true;
    /** The limit figures came from a cache past its fresh window, so they are
     *  last-known rather than live. The vitals beside them are always live. */
    stale?: true;
    vitals?: RightNowVitals;
}

/** The vitals line's figures: rounded shares, a one-decimal load and an
 *  uptime in the same compactAge voice the activity rows speak. */
export function vitalsFacts(vitals: RightNowVitals): { memoryPercent: number; diskPercent?: number; load: string; uptime: string } {
    const disk = vitals.diskUsed === undefined || vitals.diskTotal === undefined
        ? undefined
        : Math.round((vitals.diskUsed / vitals.diskTotal) * 100);
    return {
        memoryPercent: Math.round((vitals.memoryUsed / vitals.memoryTotal) * 100),
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
    return {
        limits: asLimitsPayload(raw.limits),
        ...(raw.collecting === true ? { collecting: true as const } : {}),
        ...(raw.stale === true ? { stale: true as const } : {}),
        ...(vitals === undefined ? {} : { vitals }),
    };
}

function rightNowVitals(value: unknown): RightNowVitals | undefined {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
    const raw = value as Record<string, unknown>;
    const figure = (candidate: unknown): number | undefined =>
        typeof candidate === 'number' && Number.isFinite(candidate) && candidate >= 0 ? candidate : undefined;
    const memoryUsed = figure(raw.memoryUsed);
    const memoryTotal = figure(raw.memoryTotal);
    const load1 = figure(raw.load1);
    const uptimeSeconds = figure(raw.uptimeSeconds);
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
