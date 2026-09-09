/**
 * Home header identity: pairing title and socket status copy shared by phone
 * and tablet chrome so the two layouts cannot drift.
 */

import { t } from '@/text';
import type { Theme } from '@/theme';
import { ConnectionStatus } from '../domain/ConnectionStatus';

export type HomeTab = 'sessions' | 'settings' | 'plugin';

const TAB_TITLES = {
    sessions: 'tabs.sessions',
    settings: 'tabs.settings',
} as const;

export function connectionStatusPresentation(
    socketStatus: { status: string; error?: string | null },
    theme: Theme,
): { color: string; isPulsing: boolean; text: string } {
    const copy = new ConnectionStatus(socketStatus.status, socketStatus.error).presentation();
    const colors = {
        connected: theme.colors.status.connected,
        connecting: theme.colors.status.connecting,
        disconnected: theme.colors.status.disconnected,
        error: theme.colors.status.error,
        unknown: theme.colors.status.default,
    } as const;
    const texts = {
        connected: t('status.connected'),
        connecting: t('status.connecting'),
        disconnected: t('status.disconnected'),
        pairingIssue: t('status.pairingIssue'),
        error: t('status.error'),
        empty: '',
    } as const;
    return { color: colors[copy.kind], isPulsing: copy.pulsing, text: texts[copy.textKey] };
}

export function homeHeaderTitle(
    activeTab: HomeTab,
    pluginTitle: string | undefined,
    pairedMachineTitle: string | undefined,
): string {
    if (activeTab === 'plugin') return pluginTitle ?? '';
    if (activeTab === 'sessions' && pairedMachineTitle !== undefined) return pairedMachineTitle;
    return t(TAB_TITLES[activeTab]);
}

export function pairedMachineTitle(machineName: string | undefined): string {
    return machineName || 'Paired computer';
}
