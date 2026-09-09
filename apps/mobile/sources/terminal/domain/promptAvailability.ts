import type { AgentLifecycle, HerdrTreePane } from '@muxr/contract';

export function terminalPaneStatus(pane: HerdrTreePane | undefined): AgentLifecycle {
    return pane?.promptable === true ? pane.agentStatus : 'unknown';
}

/**
 * A pane running an agent accepts a prompt even before it is promptable: the
 * host holds the prompt until the agent can take it. A pane with no agent has
 * nothing to prompt.
 */
export function terminalPaneCanSend(pane: HerdrTreePane | undefined, hasContent: boolean): boolean {
    return pane?.agentKind !== undefined && hasContent;
}
