import { create } from 'zustand';

/**
 * A Dock prompt the host is still delivering to the agent it just started, by
 * Agent Route. The agent's screen shows it as queued until delivery, and takes
 * the text back into its own draft when delivery fails.
 */
export type QueuedFirstPrompt = { text: string; failed?: true };

export const useQueuedFirstPrompts = create<Record<string, QueuedFirstPrompt>>(() => ({}));

/**
 * The one lock both send paths read: while an entry is queued, the composer
 * and the agent-command ring wait, so nothing overtakes the first prompt.
 */
export function isQueuedFirstPrompt(entry: QueuedFirstPrompt | undefined): entry is QueuedFirstPrompt {
    return entry !== undefined && entry.failed !== true;
}

/** Imperative read of the same lock, for send paths outside a render. */
export function isFirstPromptQueued(agentRoute: string): boolean {
    return isQueuedFirstPrompt(useQueuedFirstPrompts.getState()[agentRoute]);
}

export function takeQueuedFirstPrompt(agentRoute: string): void {
    useQueuedFirstPrompts.setState((queued) => {
        const { [agentRoute]: _taken, ...rest } = queued;
        return rest;
    }, true);
}
