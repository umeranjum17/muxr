import { MUXR_UI_VERSION, pluginCompatibilityError, type PluginManifestV1, type PluginSummary } from '@muxr/contract';
import { registerPluginInvalidationHandler, sync } from '@/catalog/sync';
import bakedShortcuts from '../bundledShortcuts.json';
import { resolvePluginText } from '../domain/pluginText';
import { setPluginShortcuts } from '@/../modules/plugin-shortcuts';

export type ApprovedPlugin = { summary: PluginSummary & { manifestHash: string }; manifest: PluginManifestV1 };
export type PluginCatalogEntry = { summary: PluginSummary; manifest?: PluginManifestV1 };
let snapshot: ApprovedPlugin[] = [];
let catalog: PluginCatalogEntry[] = [];
let loadedOnce = false;
let loading: Promise<void> | undefined;
let queued = false;
let unavailable = new Map<string, string>();
let shortcutProjection = '';
const manifestCache = new Map<string, PluginManifestV1>();
const listeners = new Set<() => void>();

function cacheKey(pluginId: string, manifestHash: string): string { return `${pluginId}:${manifestHash}`; }
function sameSummary(left: PluginSummary, right: PluginSummary): boolean { return JSON.stringify(left) === JSON.stringify(right); }

export function pluginSnapshot(): ApprovedPlugin[] { return snapshot; }
export function pluginCatalogSnapshot(): PluginCatalogEntry[] { return catalog; }
export function pluginCatalogLoaded(): boolean { return loadedOnce; }
export function pluginUnavailableReason(pluginId: string): string | undefined {
    const entry = catalog.find((candidate) => candidate.summary.pluginId === pluginId);
    return unavailable.get(pluginId) ?? entry?.summary.warnings[0];
}
export function subscribePlugins(listener: () => void): () => void { listeners.add(listener); return () => listeners.delete(listener); }

registerPluginInvalidationHandler(() => {
    void refreshPlugins().catch(() => undefined);
});

export function refreshPlugins(): Promise<void> {
    if (loading !== undefined) {
        queued = true;
        return loading;
    }
    const task = (async () => {
        do {
            queued = false;
            const plugins = await sync.request('plugin.list', {}) as PluginSummary[];
            const previous = new Map(snapshot.map((entry) => [cacheKey(entry.summary.pluginId, entry.summary.manifestHash), entry]));
            const withManifest = plugins.filter((plugin): plugin is PluginSummary & { manifestHash: string } => plugin.manifestHash !== undefined);
            const activeKeys = new Set(withManifest.map((summary) => cacheKey(summary.pluginId, summary.manifestHash)));
            const manifests = new Map(await Promise.all(withManifest.map(async (summary) => {
                const key = cacheKey(summary.pluginId, summary.manifestHash);
                let manifest = manifestCache.get(key);
                if (manifest === undefined) {
                    manifest = await sync.request('plugin.manifest', { pluginId: summary.pluginId, manifestHash: summary.manifestHash }) as PluginManifestV1;
                    manifestCache.set(key, manifest);
                }
                return [summary.pluginId, manifest] as const;
            })));
            for (const key of manifestCache.keys()) if (!activeKeys.has(key)) manifestCache.delete(key);
            catalog = plugins.map((summary) => ({ summary, ...(manifests.get(summary.pluginId) === undefined ? {} : { manifest: manifests.get(summary.pluginId)! }) }));
            loadedOnce = true;
            unavailable = new Map(catalog.flatMap(({ summary, manifest }) => {
                const reason = manifest === undefined ? undefined : pluginCompatibilityError(manifest, MUXR_UI_VERSION);
                return reason === undefined ? [] : [[summary.pluginId, reason] as const];
            }));
            for (const [pluginId, reason] of unavailable) console.warn(`[plugin ${pluginId}] ${reason}`);
            snapshot = withManifest.flatMap((summary) => {
                if (!summary.approved || unavailable.has(summary.pluginId)) return [];
                const manifest = manifests.get(summary.pluginId)!;
                const existing = previous.get(cacheKey(summary.pluginId, summary.manifestHash));
                return [existing !== undefined && sameSummary(existing.summary, summary) ? existing : { summary, manifest }];
            });
            const shortcuts = snapshot.flatMap(({ summary, manifest }) => manifest.contributions.flatMap((contribution) =>
                contribution.slot === 'shortcuts' ? [{
                    id: `${summary.pluginId}.${contribution.id}`,
                    label: resolvePluginText(contribution.label),
                    longLabel: resolvePluginText(contribution.longLabel ?? contribution.label),
                }] : [],
            )).sort((left, right) => left.id.localeCompare(right.id));
            const bakedIds = (bakedShortcuts as Array<{ id: string }>).map(({ id }) => id).sort();
            const nextProjection = JSON.stringify([shortcuts, bakedIds]);
            if (nextProjection !== shortcutProjection) {
                setPluginShortcuts(shortcuts, bakedIds);
                shortcutProjection = nextProjection;
            }
            for (const listener of listeners) listener();
        } while (queued);
    })();
    const tracked = task.finally(() => {
        if (loading === tracked) loading = undefined;
        // Invalidation during a failed fetch never entered the loop again.
        if (queued) void refreshPlugins().catch(() => undefined);
    });
    loading = tracked;
    return tracked;
}
