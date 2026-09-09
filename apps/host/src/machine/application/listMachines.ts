export type ListMachinesCommand = {
    machineId: string;
    machineName?: string;
    hostVersion: string;
    platform: string;
    now?: () => Date;
};

export type ListedMachine = {
    machineId: string;
    name?: string;
    online: true;
    hostVersion: string;
    platform: string;
    lastSeenAt: string;
};

export type ListMachinesResult = { ok: true; data: ListedMachine[] };

export function listMachines(command: ListMachinesCommand): ListMachinesResult {
    const name = command.machineName?.trim();
    return {
        ok: true,
        data: [{
            machineId: command.machineId,
            ...(name ? { name } : {}),
            online: true,
            hostVersion: command.hostVersion,
            platform: command.platform,
            lastSeenAt: (command.now ?? (() => new Date()))().toISOString(),
        }],
    };
}
