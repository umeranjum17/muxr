import { getCachedConnectionSettings } from '@/connection';

function pathForeignToHome(path: string, homeDir: string): boolean {
    if (path === '~' || (!path.startsWith('/') && !/^[A-Za-z]:[\\/]/.test(path))) return false;
    const home = homeDir.replace(/[/\\]+$/, '');
    return path !== home && !path.startsWith(`${home}/`) && !path.startsWith(`${home}\\`);
}

/**
 * The folder the Dock starts in: the one picked, else the last one an agent
 * started in on this device (from the Dock or New agent), else the folder
 * setup chose on that computer, else home. Foreign selected/last-used paths
 * fall back to home; the setup default belongs to the connected host.
 */
export function dockStartPath(selectedPath: string | null, homeDir: string | undefined, hostDefault?: string): string {
    const chosenPath = selectedPath?.trim() || getCachedConnectionSettings().lastSessionCwd;
    if (chosenPath) return homeDir && pathForeignToHome(chosenPath, homeDir) ? '~' : chosenPath;
    return hostDefault?.trim() || '~';
}
