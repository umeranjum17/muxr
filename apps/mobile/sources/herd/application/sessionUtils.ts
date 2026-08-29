import * as React from 'react';
import { Session } from '@/catalog';
import { t } from '@/text';
import { useUnistyles } from 'react-native-unistyles';
import type { Theme } from '@/theme';
import { formatLastSeen, formatPathRelativeToHome } from '../domain/sessionIdentity';
import type { HerdrTreePane } from '@muxr/contract';

export type SessionState = 'disconnected' | 'thinking' | 'waiting' | 'permission_required';

export interface SessionStatus {
    state: SessionState;
    isConnected: boolean;
    statusText: string;
    shouldShowStatus: boolean;
    statusColor: string;
    statusDotColor: string;
    isPulsing?: boolean;
}

export interface SessionStateColors {
    color: string;
    dotColor: string;
    isPulsing: boolean;
    isConnected: boolean;
}

/** The single source of truth for session-row status colors, resolved from theme tokens. */
export function sessionStateColors(state: SessionState, theme: Theme): SessionStateColors {
    switch (state) {
        case 'thinking':
            return { color: theme.colors.status.working, dotColor: theme.colors.status.working, isPulsing: true, isConnected: true };
        case 'waiting':
            return { color: theme.colors.status.done, dotColor: theme.colors.status.done, isPulsing: false, isConnected: true };
        case 'permission_required':
            return { color: theme.colors.status.error, dotColor: theme.colors.status.error, isPulsing: true, isConnected: true };
        default:
            return { color: theme.colors.status.disconnected, dotColor: theme.colors.status.disconnected, isPulsing: false, isConnected: false };
    }
}

/** Unread results override any state with the solid unread accent. */
export function unreadStateColors(theme: Theme, base: SessionStateColors): SessionStateColors {
    return { ...base, color: theme.colors.status.unread, dotColor: theme.colors.status.unread, isPulsing: false };
}

/**
 * Get the current state of a session based on presence and thinking status.
 * Uses centralized session state from storage.ts
 */
export function useSessionStatus(session: Session | undefined): SessionStatus {
    const { theme } = useUnistyles();
    const isOnline = session?.presence === "online";
    const hasPermissions = Object.keys(session?.agentState?.requests ?? {}).length > 0;

    const vibingMessage = React.useMemo(() => {
        return vibingMessages[Math.floor(Math.random() * vibingMessages.length)].toLowerCase() + '…';
    }, [isOnline, hasPermissions, session?.thinking]);

    if (!session) {
        // Row may still be mounted for a render after the session was removed
        // from the store. Behave like a disconnected session.
        return {
            state: 'disconnected',
            isConnected: false,
            statusText: t('status.disconnected'),
            shouldShowStatus: true,
            statusColor: theme.colors.status.disconnected,
            statusDotColor: theme.colors.status.disconnected
        };
    }

    if (!isOnline) {
        return {
            state: 'disconnected',
            isConnected: false,
            statusText: t('status.lastSeen', { time: formatLastSeen(session.activeAt, false) }),
            shouldShowStatus: true,
            statusColor: theme.colors.status.disconnected,
            statusDotColor: theme.colors.status.disconnected
        };
    }

    // Check if permission is required
    if (hasPermissions) {
        return {
            state: 'permission_required',
            isConnected: true,
            statusText: t('status.permissionRequired'),
            shouldShowStatus: true,
            statusColor: theme.colors.status.error,
            statusDotColor: theme.colors.status.error,
            isPulsing: true
        };
    }

    if (session.thinking === true) {
        return {
            state: 'thinking',
            isConnected: true,
            statusText: vibingMessage,
            shouldShowStatus: true,
            statusColor: theme.colors.status.working,
            statusDotColor: theme.colors.status.working,
            isPulsing: true
        };
    }

    return {
        state: 'waiting',
        isConnected: true,
        statusText: t('status.online'),
        shouldShowStatus: false,
        statusColor: theme.colors.status.done,
        statusDotColor: theme.colors.status.done
    };
}

/** Generic sessions may carry their own summary; Herdr Agent titles come from the tree. */
export function getSessionName(session: Session, pane?: HerdrTreePane): string {
    if (pane !== undefined) return pane.taskTitle ?? pane.agentName ?? t('session.newChat');
    return session.metadata?.summary?.text?.trim() || t('session.newChat');
}

/** herdr lifecycle status, shared across dots, kanban and grid tiles. */
export type AgentLifecycleStatus = 'starting' | 'idle' | 'working' | 'blocked' | 'done' | 'failed' | 'unknown';

/** herdr semantics: red = needs you, blue = working, green = done, grey = idle. Working/blocked pulse. */
export function agentStatusColor(status: AgentLifecycleStatus, theme: Theme): { color: string; pulsing: boolean } {
    switch (status) {
        case 'working':
        case 'starting':
            return { color: theme.colors.status.working, pulsing: true };
        case 'blocked':
            return { color: theme.colors.status.error, pulsing: true };
        case 'failed':
            return { color: theme.colors.status.error, pulsing: false };
        case 'done':
            return { color: theme.colors.status.done, pulsing: false };
        default:
            return { color: theme.colors.status.disconnected, pulsing: false };
    }
}

/**
 * Generates a deterministic avatar ID from machine ID and path.
 * This ensures the same machine + path combination always gets the same avatar.
 */
export function getSessionAvatarId(session: Session): string {
    if (session.metadata?.machineId && session.metadata?.path) {
        // Combine machine ID and path for a unique, deterministic avatar
        return `${session.metadata.machineId}:${session.metadata.path}`;
    }
    // Fallback to session ID if metadata is missing
    return session.id;
}

/** Herdr Agent Names come from the current tree, never session metadata. */
export function getSessionSubtitle(_session: Session, pane?: HerdrTreePane): string {
    return pane?.agentName ?? '';
}

/**
 * Checks if a session is currently online based on the active flag.
 * A session is considered online if the active flag is true.
 */
export function isSessionOnline(session: Session): boolean {
    return session.active;
}

/**
 * Checks if a session should be shown in the active sessions group.
 * Uses the active flag directly.
 */
export function isSessionActive(session: Session): boolean {
    return session.active;
}

export function formatOSPlatform(platform?: string): string {
    if (!platform) return '';
    const osMap: Record<string, string> = {
        darwin: 'macOS',
        win32: 'Windows',
        linux: 'Linux',
        android: 'Android',
        ios: 'iOS',
        aix: 'AIX',
        freebsd: 'FreeBSD',
        openbsd: 'OpenBSD',
        sunos: 'SunOS',
    };
    return osMap[platform.toLowerCase()] || platform;
}

export const vibingMessages = ["Accomplishing", "Actioning", "Actualizing", "Baking", "Booping", "Brewing", "Calculating", "Cerebrating", "Channelling", "Churning", "Clauding", "Coalescing", "Cogitating", "Computing", "Combobulating", "Concocting", "Conjuring", "Considering", "Contemplating", "Cooking", "Crafting", "Creating", "Crunching", "Deciphering", "Deliberating", "Determining", "Discombobulating", "Divining", "Doing", "Effecting", "Elucidating", "Enchanting", "Envisioning", "Finagling", "Flibbertigibbeting", "Forging", "Forming", "Frolicking", "Generating", "Germinating", "Hatching", "Herding", "Honking", "Ideating", "Imagining", "Incubating", "Inferring", "Manifesting", "Marinating", "Meandering", "Moseying", "Mulling", "Mustering", "Musing", "Noodling", "Percolating", "Perusing", "Philosophising", "Pontificating", "Pondering", "Processing", "Puttering", "Puzzling", "Reticulating", "Ruminating", "Scheming", "Schlepping", "Shimmying", "Simmering", "Smooshing", "Spelunking", "Spinning", "Stewing", "Sussing", "Synthesizing", "Thinking", "Tinkering", "Transmuting", "Unfurling", "Unravelling", "Vibing", "Wandering", "Whirring", "Wibbling", "Wizarding", "Working", "Wrangling"];
