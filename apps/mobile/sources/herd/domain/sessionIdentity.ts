import { t } from '@/text';

export function formatPathRelativeToHome(path: string, homeDir?: string): string {
    if (!homeDir) return path;
    const normalizedHome = homeDir.endsWith('/') ? homeDir.slice(0, -1) : homeDir;
    if (!path.startsWith(normalizedHome)) return path;
    const relativePath = path.slice(normalizedHome.length);
    if (relativePath.startsWith('/')) return `~${relativePath}`;
    if (relativePath === '') return '~';
    return `~/${relativePath}`;
}

export function formatLastSeen(activeAt: number, isActive: boolean = false): string {
    if (isActive) return t('status.activeNow');
    const diffSeconds = Math.floor((Date.now() - activeAt) / 1000);
    if (diffSeconds < 60) return t('time.justNow');
    const diffMinutes = Math.floor(diffSeconds / 60);
    if (diffMinutes < 60) return t('time.minutesAgo', { count: diffMinutes });
    const diffHours = Math.floor(diffMinutes / 60);
    if (diffHours < 24) return t('time.hoursAgo', { count: diffHours });
    const diffDays = Math.floor(diffHours / 24);
    if (diffDays < 7) return t('sessionHistory.daysAgo', { count: diffDays });
    const date = new Date(activeAt);
    const options: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric' };
    if (date.getFullYear() !== new Date().getFullYear()) options.year = 'numeric';
    return date.toLocaleDateString(undefined, options);
}
