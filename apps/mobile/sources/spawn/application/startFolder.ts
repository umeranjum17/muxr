import { getCachedConnectionSettings } from '@/connection';

function pathForeignToHome(path: string, homeDir: string): boolean {
    if (path === '~' || (!path.startsWith('/') && !/^[A-Za-z]:[\\/]/.test(path))) return false;
    const home = homeDir.replace(/[/\\]+$/, '');
    return path !== home && !path.startsWith(`${home}/`) && !path.startsWith(`${home}\\`);
}

/**
 * The folder the Dock starts in: the one picked, else the last one an agent
 * started in on this device (from the Dock or New agent), else the folder
 * setup chose on the connected host, else home. A last-used path from another
 * computer is skipped; the setup default is the host's own path and always kept.
 */
export function dockStartPath(selectedPath: string | null, homeDir: string | undefined, hostDefault?: string): string {
    const chosenPath = selectedPath?.trim() || getCachedConnectionSettings().lastSessionCwd;
    if (chosenPath && !(homeDir && pathForeignToHome(chosenPath, homeDir))) return chosenPath;
    return hostDefault?.trim() || '~';
}
