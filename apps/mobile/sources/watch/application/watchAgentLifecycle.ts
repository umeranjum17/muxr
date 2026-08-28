export type WatchAgentLifecycleCommand = {
    authority: string;
    machineId: string;
};

export type WatchAgentLifecycleResult = {
    scope: string;
};

export type WatchAgentLifecyclePorts = {
    setScope: (scope: string) => void;
};

/** Agent Watch is machine-scoped. An empty machine id is the account-only surface. */
export function watchAgentLifecycle(
    command: WatchAgentLifecycleCommand,
    ports: WatchAgentLifecyclePorts,
): WatchAgentLifecycleResult {
    const machine = command.machineId.trim();
    const scope = `${command.authority}:${machine === '' ? 'account' : machine}`;
    ports.setScope(scope);
    return { scope };
}
