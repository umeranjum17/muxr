/** Human-facing OS label for this Machine. Internal ids stay off this string. */
export function hostPlatformLabel(): string {
    if (process.platform === 'darwin') return 'macOS';
    if (process.platform === 'win32') return 'Windows';
    if (process.platform === 'linux') return 'Linux';
    return process.platform;
}
