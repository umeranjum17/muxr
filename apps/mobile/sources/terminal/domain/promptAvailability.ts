import type { AgentLifecycle, HerdrTreePane } from '@muxr/contract';

export const DIALOG_GUARD_TITLE = 'Dialog waiting';
export const DIALOG_GUARD_MESSAGE = 'A dialog is waiting — answer it first, then send.';
export const DIALOG_GUARD_ACTION = 'Show me the message';

type SessionPromptState = {
    metadata?: { agentStatus?: string; lifecycleState?: string } | null;
    agentState?: { requests?: Record<string, unknown> | null } | null;
};

export type TerminalInputDisposition =
    | { kind: 'prompt' }
    | { kind: 'answer'; answer: 'y' | 'n' }
    | { kind: 'blocked' };

export function terminalPaneStatus(pane: HerdrTreePane | undefined): AgentLifecycle {
    return pane?.promptable === true ? pane.agentStatus : 'unknown';
}

/** A waiting/blocked state means the pane already has a question to answer. */
export function terminalHasOutstandingPrompt(
    pane: { agentStatus?: string } | undefined,
    session?: SessionPromptState,
): boolean {
    return pane?.agentStatus === 'waiting'
        || pane?.agentStatus === 'blocked'
        || session?.metadata?.agentStatus === 'waiting'
        || session?.metadata?.agentStatus === 'blocked'
        || session?.metadata?.lifecycleState === 'waiting'
        || session?.metadata?.lifecycleState === 'blocked'
        || Object.keys(session?.agentState?.requests ?? {}).length > 0;
}

/**
 * Only the protocol's literal y/n answer bypasses the composer guard. Every
 * other value stays blocked because the session does not carry a prompt kind.
 */
export function terminalInputDisposition(
    pane: { agentStatus?: string } | undefined,
    session: SessionPromptState | undefined,
    text: string,
): TerminalInputDisposition {
    if (!terminalHasOutstandingPrompt(pane, session)) return { kind: 'prompt' };
    const answer = text.trim().toLowerCase();
    if (answer === 'y' || answer === 'n') return { kind: 'answer', answer };
    return { kind: 'blocked' };
}

/**
 * A pane running an agent accepts a prompt even before it is promptable: the
 * host holds the prompt until the agent can take it. A pane with no agent has
 * nothing to prompt.
 */
export function terminalPaneCanSend(pane: HerdrTreePane | undefined, hasContent: boolean): boolean {
    return pane?.agentKind !== undefined && hasContent;
}
