import { getCachedConnectionSettings } from '@/connection';

/**
 * The folder the Dock starts in: the one picked, else the one an agent last
 * started in on this machine, else the folder setup chose on that machine's
 * host, else home. A folder remembered for another machine never applies, and
 * a start remembered before setup chose a folder never shadows that choice.
 */
export function dockStartPath(selectedPath: string | null, machineId: string | undefined, hostDefault?: string): string {
    const picked = selectedPath?.trim();
    if (picked) return picked;
    const settings = getCachedConnectionSettings();
    const host = hostDefault?.trim() || undefined;
    const remembered = machineId === undefined ? undefined : settings.lastSessionCwdByMachine?.[machineId];
    // Where setup stood when this start was remembered. Setup saving a folder
    // since makes the memory stale, so the fresh choice wins on this launch.
    const setupAtStart = machineId === undefined ? undefined : settings.startFolderSetupByMachine?.[machineId];
    const setupFolderChanged = setupAtStart !== undefined && setupAtStart !== (host ?? '');
    return (remembered !== undefined && !setupFolderChanged ? remembered : undefined) ?? host ?? '~';
}
