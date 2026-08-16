import * as React from 'react';
import { PLUGIN_CALL_CLIENT_TIMEOUT_MS, type PluginEventTrigger, type PluginManifestV1, type PluginSummary } from '@muxr/contract';
import { sync } from '@/sync/sync';
import { storage } from '@/sync/storage';
import { capabilityFor } from './capabilityRegistry';
import { firedTriggers } from './pluginEvents';
import { pluginSnapshot } from './pluginStore';

/** Enough of the tail for a plugin to summarise. */
const REPORT_LINES = 80;
const MAX_REPORT_CHARS = 4000;

/**
 * Run manifest-declared triggers. Plugins cannot poll, so this is the kernel
 * side of "when this happens, do that": it watches state the app already syncs
 * and calls the plugin's own RPC. It knows no feature names.
 */
export function usePluginEvents(): void {
    React.useEffect(() => {
        // ponytail: 1.5s diff of the session map, same cadence the lifecycle
        // notifier already uses. Push it down the sync layer if it ever costs.
        const seen = new Map<string, string>();
        let first = true;
        const tick = () => {
            const sessions = storage.getState().sessions;
            const active = new Set(Object.keys(sessions));
            for (const sessionId of seen.keys()) if (!active.has(sessionId)) seen.delete(sessionId);
            const changed: { sessionId: string; from: string; to: string }[] = [];
            for (const [sessionId, session] of Object.entries(sessions)) {
                const status = session?.metadata?.agentStatus;
                if (status === undefined) continue;
                const was = seen.get(sessionId);
                seen.set(sessionId, status);
                if (was !== undefined && was !== status) changed.push({ sessionId, from: was, to: status });
            }
            // The first pass only records where everything already was.
            if (first) { first = false; return; }
            const declared = triggers();
            for (const { sessionId, from, to } of changed) {
                for (const { trigger, plugin, manifest } of declared) {
                    if (firedTriggers([trigger], from, to).length === 0) continue;
                    void run(trigger, plugin, manifest, sessionId, to).catch((error: unknown) => {
                        const message = error instanceof Error ? error.message : String(error);
                        console.warn(`[plugin ${plugin.pluginId}] event ${trigger.id} failed: ${message.slice(0, 300)}`);
                    });
                }
            }
        };
        const timer = setInterval(tick, 1500);
        return () => clearInterval(timer);
    }, []);
}

async function run(trigger: PluginEventTrigger, plugin: PluginSummary & { manifestHash: string }, manifest: PluginManifestV1, sessionId: string, status: string): Promise<void> {
    const input: { sessionId: string; status: string; from: string; pane?: string } = { sessionId, status, from: trigger.from };
    if (trigger.action.include === 'pane') {
        const { text } = await sync.request('pane.read', { sessionId, lines: REPORT_LINES, source: 'recent_unwrapped', ansi: false });
        input.pane = text.trim().slice(-MAX_REPORT_CHARS);
    }
    if (trigger.action.type === 'capability') {
        // Unregistered name: an older app meeting a newer manifest. Skip it.
        await capabilityFor(trigger.action.name, manifest)?.(input);
        return;
    }
    await sync.request('plugin.call', {
        pluginId: plugin.pluginId,
        manifestHash: plugin.manifestHash,
        contributionId: trigger.action.contributionId,
        input,
    }, PLUGIN_CALL_CLIENT_TIMEOUT_MS);
}

function triggers(): { trigger: PluginEventTrigger; plugin: PluginSummary & { manifestHash: string }; manifest: PluginManifestV1 }[] {
    return pluginSnapshot().flatMap(({ summary, manifest }) => manifest.contributions.flatMap((contribution) =>
        contribution.slot === 'events' ? [{ trigger: contribution as PluginEventTrigger, plugin: summary, manifest }] : []));
}
