import { wakeAndReport } from '@/watch/wakeAndReport';
import { startRealtimeCapability } from '@/conversation';
import { type MountedSurface, waitForPrimitive } from './primitivePresence';

/** Input a capability receives when an event trigger fires. */
export type CapabilityInput = { sessionId: string; status: string; from: string; pane?: string };

type CapabilityRegistration = {
    run: (input: CapabilityInput) => void | Promise<void>;
    /** Product surface that must mount before the effect runs. */
    requiredPrimitive?: MountedSurface;
};

/**
 * Effects a manifest can ask for on the phone. Each name is a thin adapter over
 * a named use case: speech.wake → ReportAgentOutcome, voice.start → FocusAgent
 * then StartRealtimeConversation. Downloaded manifests can reference behaviour,
 * never introduce it or bypass product surface readiness.
 */
const registry: Record<string, CapabilityRegistration> = {
    'speech.wake': { run: wakeAndReport, requiredPrimitive: 'realtime-session-overlay' },
    'voice.start': {
        run: (input) => startRealtimeCapability({ ...(input.sessionId === '' ? {} : { sessionId: input.sessionId }) }),
        requiredPrimitive: 'realtime-session-overlay',
    },
};

export function capabilityFor(name: string): ((input: CapabilityInput) => Promise<void>) | undefined {
    if (!Object.prototype.hasOwnProperty.call(registry, name)) return undefined;
    const registration = registry[name]!;
    return invoke(registration);
}

/**
 * A baked product shortcut has no manifest to declare the surface it needs;
 * the product mounts its own primitives, so only the runtime wait applies.
 */
export function productCapabilityFor(name: string): ((input: CapabilityInput) => Promise<void>) | undefined {
    if (!Object.prototype.hasOwnProperty.call(registry, name)) return undefined;
    return invoke(registry[name]!);
}

function invoke(registration: CapabilityRegistration): (input: CapabilityInput) => Promise<void> {
    return async (input) => {
        if (registration.requiredPrimitive !== undefined && !await waitForPrimitive(registration.requiredPrimitive)) {
            throw new Error(`Required product surface did not mount: ${registration.requiredPrimitive}`);
        }
        await registration.run(input);
    };
}
