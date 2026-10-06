/**
 * One shared connection summary read by the Home header and the Connection
 * screen. The socket is authoritative for online/offline; the herdr runtime
 * (from `herdr.tree`, via the catalog store) is a separate dimension. Both
 * surfaces derive from {@link summarizeConnection}, so they cannot disagree:
 * a dead runtime never reads as offline, and a live link never reads as
 * fully healthy while the runtime is down.
 */

import { t } from '@/text';
import type { Theme } from '@/theme';
import { ConnectionStatus } from '../domain/ConnectionStatus';

/** Link down plus runtime liveness in one read. Only an explicit runtime
 *  `false` counts as down; `undefined` is unknown, not healthy. */
export function summarizeConnection(
    socket: { status: string },
    herdrRuntime: boolean | undefined,
): { linkDown: boolean; runtimeDown: boolean } {
    const linkDown = socket.status === 'error' || socket.status === 'disconnected';
    return { linkDown, runtimeDown: !linkDown && socket.status === 'connected' && herdrRuntime === false };
}

export function connectionStatusPresentation(
    socketStatus: { status: string; error?: string | null },
    theme: Theme,
    linkDown = false,
): { color: string; isPulsing: boolean; text: string } {
    if (/^(Pair again:|Update needed:|Access removed:)/.test(socketStatus.error ?? '')) {
        return { color: theme.colors.status.error, isPulsing: false, text: 'needs pairing' };
    }
    // Link down only: a dead agent runtime keeps the link up, so the header
    // stays on the link copy while the recovery card carries the runtime news.
    if (linkDown) {
        return { color: theme.colors.status.disconnected, isPulsing: false, text: t('status.offline') };
    }
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

/** The Connection screen Status subtitle, from the same summary as the header. */
export function connectionStatusSubtitle(input: {
    status: string;
    socketError?: string | null;
    latestFailure?: string;
    hostRefresh: 'loading' | 'ready' | 'failed';
    herdrRuntime: boolean | undefined;
}): string {
    if (input.status === 'connected') {
        if (input.hostRefresh === 'loading') return 'Relay connected; checking the computer…';
        if (input.hostRefresh === 'failed') return 'Relay connected; the computer did not answer. Try Reconnect now or muxr doctor there.';
        if (summarizeConnection({ status: input.status }, input.herdrRuntime).runtimeDown) {
            return 'Relay connected; the agent runtime is not answering. See Home for the restart command.';
        }
        return 'Relay connected; the computer answered the last check.';
    }
    return input.socketError ?? input.latestFailure ?? 'The app reconnects on its own when the machine is back';
}

export function homeHeaderTitle(pairedMachineTitle: string | undefined): string {
    if (pairedMachineTitle !== undefined) return pairedMachineTitle;
    return t('tabs.sessions');
}

export function pairedMachineTitle(machineName: string | undefined): string {
    return machineName || 'Paired computer';
}
