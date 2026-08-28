export type ReadAgentSessionCommand = {
    agentRoute: string;
};

export type ReadAgentSessionResult<T> =
    | { ok: true; agent: T }
    | { ok: false; reason: 'not-listed' };

export type ReadAgentSessionPorts<T> = {
    listed: (agentRoute: string) => T | undefined;
};

/** Read one listed Agent by Agent Route. Display metadata never authorizes. */
export function readAgentSession<T>(
    command: ReadAgentSessionCommand,
    ports: ReadAgentSessionPorts<T>,
): ReadAgentSessionResult<T> {
    const agent = ports.listed(command.agentRoute);
    if (agent === undefined) return { ok: false, reason: 'not-listed' };
    return { ok: true, agent };
}
