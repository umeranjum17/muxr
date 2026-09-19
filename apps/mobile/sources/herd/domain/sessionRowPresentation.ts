/**
 * How a Herd row presents: status copy, card placement, subtitle, and search.
 * SessionsList renders; this module decides what each row says.
 */

import { SessionListViewItem, SessionRowData } from '@/catalog/store';
import { formatLastSeen } from './sessionIdentity';
import { compactAge } from './agentPresentation';
import { t } from '@/text';

export type SessionCardPlacement = 'single' | 'first' | 'last' | 'middle';
export type SessionSubtitleKind = 'identity' | 'machine-path' | 'subtitle';

/**
 * The card's state as a plain-language sentence plus a quiet elapsed age.
 * The sentence carries the semantics; colour stays on the dot. Duration is
 * deliberately kept out of the accessibility label so a ticking minute never
 * re-announces the row.
 */
export interface SessionStateCopy {
    /** What the row shows; working rows keep the established vibing voice. */
    sentence: string;
    /** What accessibility reads: factual, never the vibing personality. */
    factual: string;
    /** Age of the current state, when the session knows when it began. */
    elapsed: string | null;
}

function stateAge(session: Pick<SessionRowData, 'lifecycleSince'>, now: number): string | null {
    if (session.lifecycleSince === undefined) return null;
    const age = compactAge(now - session.lifecycleSince);
    // 'now' reads wrong as a duration suffix; the minute arrives soon enough.
    return age === 'now' ? null : age;
}

export function sessionStateSentence(
    session: SessionRowData,
    vibingMessage: string,
    now: number = Date.now(),
): SessionStateCopy {
    if (session.hasUnread) {
        const done = 'Done · new results to read';
        return { sentence: done, factual: done, elapsed: null };
    }
    if (session.state === 'disconnected') {
        const seen = t('status.lastSeen', { time: formatLastSeen(session.activeAt!, false) });
        return { sentence: `Offline · ${seen}`, factual: seen, elapsed: null };
    }
    if (session.state === 'permission_required') {
        const waiting = 'Waiting for your approval';
        return { sentence: waiting, factual: waiting, elapsed: stateAge(session, now) };
    }
    if (session.state === 'thinking') {
        return { sentence: vibingMessage, factual: 'Working', elapsed: stateAge(session, now) };
    }
    return { sentence: 'Idle', factual: 'Idle', elapsed: stateAge(session, now) };
}

/** The quiet mono caption: machine and path leaf, only from what exists. */
export function sessionMachineCaption(session: Pick<SessionRowData, 'host' | 'path'>): string | null {
    const host = session.host?.trim() || null;
    const leaf = session.path ? sessionPathLeaf(session.path) : null;
    if (host === null && leaf === null) return null;
    return [host, leaf].filter((value): value is string => value !== null).join(' · ');
}

export function sessionCardPlacement(isFirst?: boolean, isLast?: boolean, isSingle?: boolean): SessionCardPlacement {
    if (isSingle) return 'single';
    if (isFirst) return 'first';
    if (isLast) return 'last';
    return 'middle';
}

export function sessionSubtitleKind(session: SessionRowData): SessionSubtitleKind {
    if (session.identityLine) return 'identity';
    if (session.host || session.path) return 'machine-path';
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
