import type { PreviewPresence, SessionInfo } from '@trymuxr/contract';

/** Stamp one session list with the announced presence, by pane. */
export function withPreview(
    sessions: SessionInfo[],
    previewFor: (paneId: string) => PreviewPresence | undefined,
): SessionInfo[] {
    return sessions.map((session) => {
        const preview = session.paneId === undefined ? undefined : previewFor(session.paneId);
        // The host is the only producer of `preview`; an absent key means
        // nothing is shown, which is also what the phone reads as closed.
        if (preview === undefined) return session;
        return { ...session, preview };
    });
}

