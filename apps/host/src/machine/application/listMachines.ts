export type ListMachinesCommand = {
    machineId: string;
    machineName?: string;
    hostVersion: string;
    platform: string;
    connectionMode?: string;
    pairedDeviceCount?: number;
    defaultStartFolder?: string;
    now?: () => Date;
};

export type ListedMachine = {
    machineId: string;
    name?: string;
    online: true;
    hostVersion: string;
    platform: string;
    connectionMode?: string;
    pairedDeviceCount?: number;
    defaultStartFolder?: string;
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
            ...(command.connectionMode === undefined ? {} : { connectionMode: command.connectionMode }),
            ...(command.pairedDeviceCount === undefined ? {} : { pairedDeviceCount: command.pairedDeviceCount }),
            ...(command.defaultStartFolder === undefined ? {} : { defaultStartFolder: command.defaultStartFolder }),
            lastSeenAt: (command.now ?? (() => new Date()))().toISOString(),
        }],
    };
}
