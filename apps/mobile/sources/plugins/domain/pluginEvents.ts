import type { PluginEventTrigger } from '@muxr/contract';

/**
 * Which declared triggers this transition fires.
 *
 * The transition is the signal, not the value: agentStatus sits at 'done'
 * indefinitely, so acting on the value would repeat every tick.
 */
export function firedTriggers(triggers: PluginEventTrigger[], from: string, to: string): PluginEventTrigger[] {
    if (from === to) return [];
    return triggers.filter((trigger) => trigger.from === from && trigger.to.includes(to as never));
}
