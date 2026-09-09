/**
 * How a Herd row presents: status copy, card placement, subtitle, and search.
 * SessionsList renders; this module decides what each row says.
 */

import { SessionListViewItem, SessionRowData } from '@/catalog/store';
import { formatLastSeen } from './sessionIdentity';
import { t } from '@/text';

export type SessionCardPlacement = 'single' | 'first' | 'last' | 'middle';
export type SessionSubtitleKind = 'identity' | 'path' | 'subtitle';

export function sessionRowStatusCopy(
    session: SessionRowData,
    vibingMessage: string,
): { visible: string; factual: string } {
    if (session.hasUnread) {
        const unread = t('status.unread');
        return { visible: unread, factual: unread };
    }
    if (session.state === 'disconnected') {
        const lastSeen = t('status.lastSeen', { time: formatLastSeen(session.activeAt!, false) });
        return { visible: lastSeen, factual: lastSeen };
    }
    if (session.state === 'permission_required') {
        const required = t('status.permissionRequired');
        return { visible: required, factual: required };
    }
    if (session.state === 'thinking') {
        return { visible: vibingMessage, factual: t('status.online') };
    }
    const online = t('status.online');
    return { visible: online, factual: online };
}

export function sessionCardPlacement(isFirst?: boolean, isLast?: boolean, isSingle?: boolean): SessionCardPlacement {
    if (isSingle) return 'single';
    if (isFirst) return 'first';
    if (isLast) return 'last';
    return 'middle';
}

export function sessionSubtitleKind(session: SessionRowData): SessionSubtitleKind {
    if (session.identityLine) return 'identity';
    if (session.path) return 'path';
    return 'subtitle';
}

export function sessionPathLeaf(path: string): string {
    return path.split(/[/\\]/).filter(Boolean).pop() ?? path;
}

export function filterSessionList(
    sourceData: SessionListViewItem[] | undefined | null,
    searchQuery: string,
): SessionListViewItem[] | undefined {
    const normalizedQuery = searchQuery.trim().toLocaleLowerCase();
    if (!sourceData || !normalizedQuery) return sourceData ?? undefined;

    const matches = (session: SessionRowData) => [
        session.name,
        session.subtitle,
        session.path,
        session.machineId,
        session.flavor,
    ].some((value) => value?.toLocaleLowerCase().includes(normalizedQuery));

    const keepIndices = new Set<number>();
    let currentHeaderIndex: number | null = null;

    sourceData.forEach((item, index) => {
        if (item.type === 'header') {
            currentHeaderIndex = index;
            return;
        }
        if (item.type === 'session' && matches(item.session)) {
            keepIndices.add(index);
            if (currentHeaderIndex !== null) keepIndices.add(currentHeaderIndex);
        }
    });

    const result: SessionListViewItem[] = [];
    sourceData.forEach((item, index) => {
        if (item.type === 'active-sessions') {
            const sessions = item.sessions.filter(matches);
            if (sessions.length > 0) result.push({ ...item, sessions });
            return;
        }
        if (keepIndices.has(index)) result.push(item);
    });
    return result;
}
