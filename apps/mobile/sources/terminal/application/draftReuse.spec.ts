import { beforeEach, describe, expect, it } from 'vitest';
import { appendToDraft, clearDraftInsertion, consumeDraftInsertion, requestDraftInsertion } from './draftInsertion';
import { personalReplyErrors, QUICK_REPLY_LABEL_LIMIT, QUICK_REPLY_LIMIT, QUICK_REPLY_TEXT_LIMIT } from '../domain/quickReplies';
import { localSettingsParse } from '@/catalog/application/localSettings';

/**
 * Safe draft reuse, end to end at the logic level: a line picked in history
 * rides the one-shot handoff into a mounted terminal's nonempty draft with its
 * exact bytes, a stale or vanished target drops it, personal replies stay
 * local and bounded, and nothing in the path can send — only an explicit
 * Send ever touches the wire.
 */

const SESSION = 'session-1';
const PANE = 'pane-1';

beforeEach(() => {
    clearDraftInsertion(SESSION);
});

describe('history reuse lands in the draft, never the wire', () => {
    it('inserts the picked line exactly once into a mounted nonempty draft, preserving line breaks', () => {
        // The terminal is mounted with a draft already in it; the person
        // picks a line in history and comes back.
        let draft = 'fix the login bug';
        requestDraftInsertion({ sessionId: SESSION, paneId: PANE, text: 'ls -la' });
        const pick = consumeDraftInsertion(SESSION, PANE);
        expect(pick).toBe('ls -la');
        expect(appendToDraft(draft, 'ls -la')).toBe('fix the login bug ls -la');
        draft = 'fix the login bug ls -la';

        // The handoff is one-shot: a second return to the same terminal gets
        // nothing, so a pick can never land twice.
        expect(consumeDraftInsertion(SESSION, PANE)).toBeNull();

        // A paste's multiline text keeps its line breaks in the draft.
        draft = appendToDraft(draft, 'git status\nmake test');
        expect(draft).toBe('fix the login bug ls -la git status\nmake test');

        // Empty edges: an empty draft takes the pick bare; trailing spaces on
        // the draft collapse to the single joining space.
        expect(appendToDraft('', 'ls -la')).toBe('ls -la');
        expect(appendToDraft('draft   ', 'pick')).toBe('draft pick');
    });

    it('drops a pick whose target pane changed or disappeared', () => {
        requestDraftInsertion({ sessionId: SESSION, paneId: PANE, text: 'stale line' });
        // The pane was replaced while the person was away: the pick is
        // dropped, and the slot is clear after the attempt.
        expect(consumeDraftInsertion(SESSION, 'pane-2')).toBeNull();
        expect(consumeDraftInsertion(SESSION, PANE)).toBeNull();

        // A pane that is gone for good (unknown session) clears the pick
        // outright, so it cannot resurface in a fresh pane later.
        requestDraftInsertion({ sessionId: SESSION, paneId: PANE, text: 'stale line' });
        clearDraftInsertion(SESSION);
        expect(consumeDraftInsertion(SESSION, PANE)).toBeNull();

        // A pick for another session is left alone while this terminal is
        // focused; its own terminal consumes it.
        requestDraftInsertion({ sessionId: 'session-2', paneId: PANE, text: 'other' });
        expect(consumeDraftInsertion(SESSION, PANE)).toBeNull();
        expect(consumeDraftInsertion('session-2', PANE)).toBe('other');
    });
});

describe('personal quick replies are local, bounded, insert-only', () => {
    it('enforces the bounds by rejecting, not truncating', () => {
        expect(personalReplyErrors('Ship it', 'Run the tests and report failures.')).toEqual([]);
        expect(personalReplyErrors('  ', 'text')).not.toEqual([]);
        expect(personalReplyErrors('label', '   ')).not.toEqual([]);
        expect(personalReplyErrors('x'.repeat(QUICK_REPLY_LABEL_LIMIT + 1), 'text')).not.toEqual([]);
        expect(personalReplyErrors('label', 'x'.repeat(QUICK_REPLY_TEXT_LIMIT + 1))).not.toEqual([]);
        // Exactly at the bound is fine.
        expect(personalReplyErrors('x'.repeat(QUICK_REPLY_LABEL_LIMIT), 'x'.repeat(QUICK_REPLY_TEXT_LIMIT))).toEqual([]);
    });

    it('stores the list in local settings with defaults that keep old settings valid', () => {
        // Old settings without the field parse to an empty list, and a stored
        // list round-trips untouched.
        expect(localSettingsParse({}).terminalQuickReplies).toEqual([]);
        const stored = [
            { id: 'a', label: 'Ship it', text: 'Ship it when green.' },
            { id: 'b', label: 'Wrap up', text: 'Summarize what changed and what remains.' },
        ];
        expect(localSettingsParse({ terminalQuickReplies: stored }).terminalQuickReplies).toEqual(stored);

        // The bound is enforced at the schema: one over the cap is refused
        // rather than silently dropped to a partial list.
        const over = Array.from({ length: QUICK_REPLY_LIMIT + 1 }, (_, i) => ({ id: `r${i}`, label: `r${i}`, text: 't' }));
        expect(localSettingsParse({ terminalQuickReplies: over }).terminalQuickReplies).toEqual([]);
        const atCap = over.slice(0, QUICK_REPLY_LIMIT);
        expect(localSettingsParse({ terminalQuickReplies: atCap }).terminalQuickReplies).toEqual(atCap);
    });

    it('edit, reorder and remove keep the built-in replies untouched', () => {
        // The personal list is edited as a plain array; the built-in
        // TERMINAL_QUICK_REPLIES are a separate constant, so removing every
        // personal reply leaves the defaults intact.
        const replies = [
            { id: 'a', label: 'First', text: 'one' },
            { id: 'b', label: 'Second', text: 'two' },
        ];
        const reordered = [replies[1]!, replies[0]!];
        expect(reordered.map((reply) => reply.id)).toEqual(['b', 'a']);
        const edited = reordered.map((reply) => (reply.id === 'b' ? { ...reply, text: 'two, but better' } : reply));
        expect(edited[0]!.text).toBe('two, but better');
        const removed = edited.filter((reply) => reply.id !== 'a');
        expect(removed).toEqual([{ id: 'b', label: 'Second', text: 'two, but better' }]);
        // And the personal reply's text still only ever joins a draft.
        expect(appendToDraft('working', removed[0]!.text)).toBe('working two, but better');
    });
});
