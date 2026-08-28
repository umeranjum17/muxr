export type StopAgentCommand = {
    agentRoute: string;
    kind: 'abort' | 'stop';
};

export type StopAgentResult =
    | { ok: true }
    | { ok: false; reason: 'missing-route' };

export type StopAgentPorts = {
    abort: (agentRoute: string) => Promise<unknown>;
    stop: (agentRoute: string) => Promise<unknown>;
    refreshCatalog: () => Promise<unknown>;
};

/** Abort the current turn or stop the Agent. Agent Route authorizes. */
export async function stopAgent(command: StopAgentCommand, ports: StopAgentPorts): Promise<StopAgentResult> {
    const agentRoute = command.agentRoute.trim();
    if (agentRoute === '') return { ok: false, reason: 'missing-route' };
    if (command.kind === 'abort') {
        await ports.abort(agentRoute);
        return { ok: true };
    }
    await ports.stop(agentRoute);
    await ports.refreshCatalog();
    return { ok: true };
}
