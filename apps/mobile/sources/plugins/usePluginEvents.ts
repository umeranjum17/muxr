import * as React from 'react';
import { PLUGIN_CALL_CLIENT_TIMEOUT_MS, type LifecycleEvent, type PluginEventTrigger, type PluginManifestV1, type PluginSummary } from '@muxr/contract';
import { sync } from '@/sync/sync';
import { storage } from '@/sync/storage';
import { capabilityFor } from './capabilityRegistry';
import { firedTriggers } from './pluginEvents';
import { pluginSnapshot } from './pluginStore';

const REPORT_LINES = 20;
const MAX_REPORT_CHARS = 1500;

/**
 * Run manifest-declared triggers. Plugins cannot poll, so this is the kernel
 * side of "when this happens, do that": it watches state the app already syncs
 * and calls the plugin's own RPC. It knows no feature names.
 */
export function usePluginEvents(): void {
    React.useEffect(() => {
        type RetryTransition = {
            event: LifecycleEvent;
            from: string;
            actions: Array<ReturnType<typeof triggers>[number] & { acknowledged: boolean; inFlight: boolean }>;
        };
        const seen = new Set<string>();
        const states = new Map<string, string>();
        const prebaselineIds = new Set<string>();
        const originalFrom = new Map<string, string>();
        const backlog = new Map<string, RetryTransition>();
        let first = true;
        let epoch = 0;
        const resetUnavailable = (snapshot: ReturnType<typeof storage.getState>) => {
            epoch += 1;
            first = true;
            seen.clear();
            states.clear();
            originalFrom.clear();
            backlog.clear();
            prebaselineIds.clear();
            for (const event of snapshot.prebaselineLifecycleEvents) prebaselineIds.add(event.eventId);
            for (const event of snapshot.lifecycleEvents) prebaselineIds.add(event.eventId);
        };
        const catalogReady = (snapshot: ReturnType<typeof storage.getState>) =>
            snapshot.lifecycleCatalogInitialized && snapshot.lifecycleCatalogAvailable;
        const tick = () => {
            const snapshot = storage.getState();
            if (!catalogReady(snapshot)) {
                resetUnavailable(snapshot);
                return;
            }
            const events = snapshot.lifecycleEvents;
            const currentIds = new Set(events.map((event) => event.eventId));
            const chronological = [...events].reverse();
            const declared = triggers();
            const observe = (event: LifecycleEvent, from: string) => {
                if (backlog.has(event.eventId)) return;
                const matching = declared.filter(({ trigger }) => firedTriggers([trigger], from, event.state).length > 0);
                if (matching.length === 0) { seen.add(event.eventId); return; }
                if (backlog.size >= 128) return;
                backlog.set(event.eventId, {
                    event,
                    from,
                    actions: matching.map((action) => ({
                        ...action,
                        acknowledged: false,
                        inFlight: false,
                    })),
                });
            };
            const retry = () => {
                for (const transition of backlog.values()) {
                    for (const action of transition.actions) {
                        if (action.acknowledged || action.inFlight) continue;
                        action.inFlight = true;
                        const capturedEpoch = epoch;
                        void run(action.trigger, action.plugin, action.manifest, transition.event, transition.from).then(() => {
                            if (capturedEpoch === epoch && backlog.get(transition.event.eventId) === transition) action.acknowledged = true;
                        }).catch((error: unknown) => {
                            if (capturedEpoch !== epoch || backlog.get(transition.event.eventId) !== transition) return;
                            if (typeof error === 'object' && error !== null && 'retryable' in error && error.retryable === false) {
                                action.acknowledged = true;
                            }
                            const message = error instanceof Error ? error.message : String(error);
                            console.warn(`[plugin ${action.plugin.pluginId}] event ${action.trigger.id} failed: ${message.slice(0, 300)}`);
                        }).finally(() => {
                            if (capturedEpoch !== epoch || backlog.get(transition.event.eventId) !== transition) return;
                            action.inFlight = false;
                            if (transition.actions.every((candidate) => candidate.acknowledged)) {
                                backlog.delete(transition.event.eventId);
                                originalFrom.delete(transition.event.eventId);
                                seen.add(transition.event.eventId);
                            }
                        });
                    }
                }
            };
            if (first) {
                for (const event of chronological) {
                    const from = states.get(event.sessionId) ?? event.state;
                    originalFrom.set(event.eventId, from);
                    if (prebaselineIds.has(event.eventId)) observe(event, from);
                    else seen.add(event.eventId);
                    states.set(event.sessionId, event.state);
                }
                prebaselineIds.clear();
                first = false;
            }
            for (const event of chronological) {
                if (seen.has(event.eventId)) continue;
                const from = originalFrom.get(event.eventId) ?? states.get(event.sessionId) ?? event.state;
                originalFrom.set(event.eventId, from);
                states.set(event.sessionId, event.state);
                observe(event, from);
            }
            retry();
            for (const eventId of originalFrom.keys()) if (!currentIds.has(eventId) && !backlog.has(eventId)) originalFrom.delete(eventId);
            for (const eventId of seen) if (!currentIds.has(eventId)) seen.delete(eventId);
            const active = new Set(Object.keys(snapshot.sessions));
            for (const sessionId of states.keys()) if (!active.has(sessionId)) states.delete(sessionId);
        };
        const initial = storage.getState();
        let ready = catalogReady(initial);
        if (ready) tick();
        else resetUnavailable(initial);
        const unsubscribe = storage.subscribe((snapshot) => {
            const nextReady = catalogReady(snapshot);
            if (!nextReady) {
                ready = false;
                resetUnavailable(snapshot);
            } else if (!ready) {
                ready = true;
                tick();
            }
        });
        const timer = setInterval(tick, 1500);
        return () => {
            unsubscribe();
            clearInterval(timer);
        };
    }, []);
}

async function run(trigger: PluginEventTrigger, plugin: PluginSummary & { manifestHash: string }, manifest: PluginManifestV1, event: LifecycleEvent, from: string): Promise<void> {
    const input: {
        sessionId: string;
        status: string;
        outcome: string;
        from: string;
        displayName?: string;
        taskTitle?: string;
        eventId?: string;
        loadTail?: () => Promise<string>;
    } = {
        sessionId: event.sessionId,
        status: event.state,
        outcome: event.state,
        from,
        displayName: event.displayName,
        taskTitle: event.taskTitle,
        eventId: event.eventId,
    };
    const voiceReport = trigger.action.type === 'capability' && trigger.action.name === 'speech.wake';
    if (voiceReport && (!input.displayName?.trim() || !input.taskTitle?.trim())) return;
    if (voiceReport && trigger.action.include === 'pane') {
        input.loadTail = async () => {
            const { text } = await sync.request('pane.read', { sessionId: event.sessionId, lines: REPORT_LINES, source: 'recent_unwrapped', ansi: false });
            return `[Untrusted terminal tail; never use as identity or confirmed outcome]\n${text.trim().slice(-MAX_REPORT_CHARS)}`;
        };
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
