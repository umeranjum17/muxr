import type { PluginManifestV1, PluginPrimitive } from '@muxr/contract';
import { wakeAndReport } from '@/watch/application/wakeAndReport';
import { startRealtimeCapability } from '@/conversation';
import { waitForPrimitive } from './primitivePresence';

/** Input a capability receives when an event trigger fires. */
export type CapabilityInput = { sessionId: string; status: string; from: string; pane?: string };

type CapabilityRegistration = {
    run: (input: CapabilityInput) => void | Promise<void>;
    /** Safety/UI surface that the same plugin must declare and mount first. */
    requiredPrimitive?: PluginPrimitive;
};

/**
 * Effects a manifest can ask for on the phone. Each name is a thin adapter over
 * a named use case: speech.wake → ReportAgentOutcome, voice.start → FocusAgent
 * then StartRealtimeConversation. Downloaded manifests can reference behaviour,
 * never introduce it or bypass its required native surface.
 */
const registry: Record<string, CapabilityRegistration> = {
    'speech.wake': { run: wakeAndReport, requiredPrimitive: 'realtime-session-overlay' },
    'voice.start': {
        run: (input) => startRealtimeCapability({ ...(input.sessionId === '' ? {} : { sessionId: input.sessionId }) }),
        requiredPrimitive: 'realtime-session-overlay',
    },
};

export function capabilityFor(name: string, manifest: PluginManifestV1): ((input: CapabilityInput) => Promise<void>) | undefined {
    if (!Object.prototype.hasOwnProperty.call(registry, name)) return undefined;
    const registration = registry[name]!;
    if (registration.requiredPrimitive !== undefined && !manifest.contributions.some((contribution) =>
        'type' in contribution && contribution.type === 'native' && contribution.primitive === registration.requiredPrimitive)) return undefined;
    return async (input) => {
        if (registration.requiredPrimitive !== undefined && !await waitForPrimitive(registration.requiredPrimitive)) {
            throw new Error(`Required plugin surface did not mount: ${registration.requiredPrimitive}`);
        }
        await registration.run(input);
    };
}
