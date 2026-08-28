import { PLUGIN_CALL_CLIENT_TIMEOUT_MS, type PluginRpcCapability, type PluginRpcMode } from '@muxr/contract';
import { randomUUID } from 'expo-crypto';
import { registerPluginInvalidationHandler, sync } from '@/catalog/sync';
import { sharedPluginWriteKeys } from './domain/screenModel';
import { pluginSnapshot, refreshPlugins } from './application/pluginStore';

type CapabilityTarget = { pluginId: string; manifestHash: string; contributionId: string; mode: PluginRpcMode };
const cache = new Map<string, CapabilityTarget>();
/** One idempotency key per write capability while its input is unchanged. */
const writeKeys = sharedPluginWriteKeys;
registerPluginInvalidationHandler(() => {
    // The host replay key includes manifestHash, so retaining an ambiguous
    // write key is safe across catalog changes and prevents duplicate writes
    // when an unrelated plugin invalidates before retry.
    cache.clear();
});

/** Resolve semantic capability through the approved catalog; callers never name plugin ids. */
export async function callPlugin<T>(capability: string, input?: unknown): Promise<T> {
    let target = cache.get(capability);
    if (target === undefined) {
        await refreshPlugins();
        const matches = pluginSnapshot().filter(({ summary }) => summary.capabilities[capability] !== undefined);
        if (matches.length === 0) throw new Error(`${capability} plugin is unavailable or not approved`);
        if (matches.length > 1) throw new Error(`${capability} is claimed by multiple enabled plugins; disable all but one`);
        const { summary: plugin, manifest } = matches[0]!;
        const contributionId = plugin.capabilities[capability]!;
        const contribution = manifest.contributions.find((candidate): candidate is PluginRpcCapability =>
            candidate.slot === 'host.rpc' && candidate.id === contributionId);
        if (contribution === undefined) throw new Error(`${capability} plugin capability is not a host.rpc contribution`);
        target = {
            pluginId: plugin.pluginId,
            manifestHash: plugin.manifestHash,
            contributionId,
            mode: contribution.mode,
        };
        cache.set(capability, target);
    }
    try {
        const writeSlot = `${target.pluginId}:${target.manifestHash}:${target.contributionId}`;
        const idempotencyKey = target.mode === 'write' ? writeKeys.keyFor(writeSlot, input, newIdempotencyKey) : undefined;
        const result = await sync.request('plugin.call', {
            pluginId: target.pluginId,
            manifestHash: target.manifestHash,
            contributionId: target.contributionId,
            ...(input === undefined ? {} : { input }),
            ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
        }, PLUGIN_CALL_CLIENT_TIMEOUT_MS) as T;
        if (idempotencyKey !== undefined) writeKeys.clear(writeSlot);
        return result;
    } catch (error) {
        const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
        if (message.includes('manifest unavailable or changed')
            || message.includes('not approved')
            || message.includes('capability is not a host.rpc contribution')) {
            cache.delete(capability);
        }
        throw error;
    }
}

function newIdempotencyKey(): string {
    return randomUUID();
}
