/**
 * The one handoff between "pick text somewhere else" and "the terminal's
 * visible draft". History rows live on a different route than the composer,
 * and the composer's draft owner reloads storage only while its local value
 * is empty, so writing storage from the other route would be ignored by a
 * mounted terminal with a nonempty draft or overwritten by autosave. Instead
 * the picked text waits here, keyed by the session and the pane it was read
 * from, and the terminal's draft owner consumes it once on focus.
 *
 * The picked text is pane output, not verified shell history: it is inserted
 * into the draft and nothing else. Explicit Send is the only PTY boundary.
 */

export interface DraftInsertionRequest {
    sessionId: string;
    /** The pane the text was read from; a different pane means a stale pick. */
    paneId: string | undefined;
    text: string;
}

let pending: DraftInsertionRequest | null = null;

export function requestDraftInsertion(request: DraftInsertionRequest): void {
    pending = { ...request };
}

/**
 * Take the pending insertion for this session, or null. Taking it clears the
 * slot, so a pick lands at most once. Returns null without inserting when the
 * stored target no longer matches this pane: the pick is dropped rather than
 * landing in a different pane's draft. A pick for another session is left
 * alone; its own terminal will consume it.
 */
export function consumeDraftInsertion(sessionId: string, paneId: string | undefined): string | null {
    const request = pending;
    if (request === null || request.sessionId !== sessionId) return null;
    pending = null;
    if (request.paneId !== undefined && paneId !== undefined && request.paneId !== paneId) return null;
    return request.text;
}

/** Drop a session's pending pick, e.g. when its pane is gone for good. */
export function clearDraftInsertion(sessionId: string): void {
    if (pending !== null && pending.sessionId === sessionId) pending = null;
}

/**
 * How picked text joins the visible draft: one space between what was already
 * there and the pick, and the pick's own line breaks left exactly as read.
 * Nothing here touches the wire.
 */
export function appendToDraft(draft: string, text: string): string {
    return [draft.trimEnd(), text].filter((part) => part !== '').join(' ');
}
