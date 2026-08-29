import type { AgentLifecycle, HerdrTreePane } from '@muxr/contract';

export function terminalPaneStatus(pane: HerdrTreePane | undefined): AgentLifecycle {
    return pane?.promptable === true ? pane.agentStatus : 'unknown';
}

export function terminalPaneCanSend(pane: HerdrTreePane | undefined, hasContent: boolean): boolean {
    return pane?.promptable === true && hasContent;
}
