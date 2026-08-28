export type ForgetMachineCommand = {
    machineId: string;
};

export type ForgetMachineResult<T> =
    | { ok: true; remaining: T[] }
    | { ok: false; reason: 'missing-machine' };

export type ForgetMachinePorts<T> = {
    removeGrant: (machineId: string) => Promise<T[]>;
};

/** Forget one Hosted Grant on this device. Does not revoke computer-to-computer authority. */
export async function forgetMachine<T>(
    command: ForgetMachineCommand,
    ports: ForgetMachinePorts<T>,
): Promise<ForgetMachineResult<T>> {
    const machineId = command.machineId.trim();
    if (machineId === '') return { ok: false, reason: 'missing-machine' };
    const remaining = await ports.removeGrant(machineId);
    return { ok: true, remaining };
}
