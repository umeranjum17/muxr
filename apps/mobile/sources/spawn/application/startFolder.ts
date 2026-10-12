import { getCachedConnectionSettings } from '@/connection';

function pathForeignToHome(path: string, homeDir: string): boolean {
    if (path === '~' || (!path.startsWith('/') && !/^[A-Za-z]:[\\/]/.test(path))) return false;
    const home = homeDir.replace(/[/\\]+$/, '');
    return path !== home && !path.startsWith(`${home}/`) && !path.startsWith(`${home}\\`);
}

/**
 * The folder the Dock starts in: the one picked, else the last one an agent
 * started in on this device (from the Dock or New agent), else home. A folder
 * outside this computer's home belongs to another computer, so it is home here.
 */
export function dockStartPath(selectedPath: string | null, homeDir: string | undefined): string {
    const path = selectedPath?.trim() || getCachedConnectionSettings().lastSessionCwd || '~';
    return homeDir && pathForeignToHome(path, homeDir) ? '~' : path;
}
