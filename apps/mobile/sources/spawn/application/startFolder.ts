import { getCachedConnectionSettings } from '@/connection';

/**
 * The folder the Dock starts in: the one picked, else the last one an agent
 * started in on this machine, else the folder setup chose on that machine's
 * host, else home. A folder remembered for another machine never applies.
 */
export function dockStartPath(selectedPath: string | null, machineId: string | undefined, hostDefault?: string): string {
    const remembered = machineId === undefined ? undefined : getCachedConnectionSettings().lastSessionCwdByMachine[machineId];
    return selectedPath?.trim() || remembered || hostDefault?.trim() || '~';
}
