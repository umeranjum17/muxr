import type { CloseResult, CloseScope } from '@muxr/contract';

export type StopAgentCommand = {
    agentRoute: string;
    kind: 'abort' | 'stop';
};

export type StopAgentResult =
    | { status: 'closed'; alreadyGone?: true }
    | { status: 'cancelled' }
    | { status: 'missing-route' };

type CloseConfirmationPrompt = {
    message: string;
    confirmText: string;
};

export type StopAgentPorts = {
    abort: (agentRoute: string) => Promise<unknown>;
    stop: (agentRoute: string, confirmedScope?: CloseScope) => Promise<CloseResult>;
    refreshCatalog: () => Promise<unknown>;
    confirmClose?: (prompt: CloseConfirmationPrompt) => Promise<boolean>;
    confirmRetry?: (message: string) => Promise<boolean>;
};

function closeActionLabel(scope: CloseScope): string {
    if (scope === 'tab') return 'Close tab';
    if (scope === 'workspace') return 'Close workspace';
    return 'Close worktree group';
}

/** Abort the current turn or stop the Agent. Agent Route authorizes. Close scope is backend-driven. */
export async function stopAgent(command: StopAgentCommand, ports: StopAgentPorts): Promise<StopAgentResult> {
    const agentRoute = command.agentRoute.trim();
    if (agentRoute === '') return { status: 'missing-route' };
    if (command.kind === 'abort') {
        await ports.abort(agentRoute);
        return { status: 'closed' };
    }

    let confirmedScope: CloseScope | undefined;
    const confirmedScopes = new Set<CloseScope>();
    while (true) {
        const result = await ports.stop(agentRoute, confirmedScope);
        if (result.status === 'closed') {
            await ports.refreshCatalog();
            if (result.alreadyGone === true) return { status: 'closed', alreadyGone: true };
            return { status: 'closed' };
        }
        if (result.status === 'retryable') {
            const retry = ports.confirmRetry === undefined ? false : await ports.confirmRetry(result.message);
            if (!retry) return { status: 'cancelled' };
            continue;
        }
        if (confirmedScopes.has(result.scope)) {
            throw new Error('The host repeated the same close confirmation. Nothing was closed.');
        }
        const confirmed = ports.confirmClose === undefined ? false : await ports.confirmClose({
            message: result.message,
            confirmText: closeActionLabel(result.scope),
        });
        if (!confirmed) return { status: 'cancelled' };
        confirmedScopes.add(result.scope);
        confirmedScope = result.scope;
    }
}
