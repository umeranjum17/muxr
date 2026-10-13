import { create } from 'zustand';

/**
 * A Dock prompt the host is still delivering to the agent it just started, by
 * Agent Route. The agent's screen shows it as queued until delivery, and takes
 * the text back into its own draft when delivery fails.
 */
export const useQueuedFirstPrompts = create<Record<string, { text: string; failed?: true }>>(() => ({}));

export function takeQueuedFirstPrompt(agentRoute: string): void {
    useQueuedFirstPrompts.setState((queued) => {
        const { [agentRoute]: _taken, ...rest } = queued;
        return rest;
    }, true);
}
