import { beforeEach, describe, expect, it } from 'vitest';
import { appendToDraft, clearDraftInsertion, consumeDraftInsertion, requestDraftInsertion } from './draftInsertion';
import { DEFAULT_QUICK_ACTIONS, quickActionErrors, quickActionSends, resolveQuickActions, QUICK_ACTION_LABEL_LIMIT, QUICK_ACTION_LIMIT, QUICK_ACTION_TEXT_LIMIT } from '../domain/quickActions';
import { localSettingsParse } from '@/catalog/application/localSettings';

/**
 * Safe draft reuse, end to end at the logic level: a line picked in history
 * rides the one-shot handoff into a mounted terminal's nonempty draft with its
 * exact bytes, a stale or vanished target drops it, and nothing in that path
 * can send — only an explicit Send ever touches the wire. Quick actions are
 * the deliberate exception: a tap on one of the person's own actions sends it,
 * and this file pins which taps send and which still only fill the prompt.
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

describe('quick actions are the person\'s own, removable, and send on tap', () => {
    it('enforces the bounds by rejecting, not truncating', () => {
        expect(quickActionErrors('Ship it', 'Run the tests and report failures.')).toEqual([]);
        expect(quickActionErrors('  ', 'text')).not.toEqual([]);
        expect(quickActionErrors('label', '   ')).not.toEqual([]);
        expect(quickActionErrors('x'.repeat(QUICK_ACTION_LABEL_LIMIT + 1), 'text')).not.toEqual([]);
        expect(quickActionErrors('label', 'x'.repeat(QUICK_ACTION_TEXT_LIMIT + 1))).not.toEqual([]);
        // Exactly at the bound is fine.
        expect(quickActionErrors('x'.repeat(QUICK_ACTION_LABEL_LIMIT), 'x'.repeat(QUICK_ACTION_TEXT_LIMIT))).toEqual([]);
    });

    it('sends a finished action on tap and only fills the prompt for an unfinished one', () => {
        // Every seed is finished text, so every one of them sends on a tap.
        for (const action of DEFAULT_QUICK_ACTIONS) expect(quickActionSends(action.text)).toBe(true);
        expect(quickActionSends('/compact')).toBe(true);
        // A placeholder still to complete is the one case that fills instead.
        expect(quickActionSends('Review {file} and report back.')).toBe(false);
        expect(quickActionSends('/review {instructions}')).toBe(false);
        // Braces that are not a placeholder are ordinary text and still send.
        expect(quickActionSends('Return {} when empty.')).toBe(true);
    });

    it('seeds a new device, lets every seed be removed, and survives a bad list', () => {
        // Nothing stored is not the same as an empty list: a device that has
        // never been configured still starts from the three it always showed.
        expect(localSettingsParse({}).terminalQuickActions).toBeNull();
        expect(resolveQuickActions(null).map((action) => action.label)).toEqual(['Continue', 'Run tests', 'Summarize']);

        // Removing them all is a choice the device keeps, not an absence that
        // brings the seeds back on the next launch.
        expect(localSettingsParse({ terminalQuickActions: [] }).terminalQuickActions).toEqual([]);
        expect(resolveQuickActions([])).toEqual([]);

        // A stored arrangement round-trips, including a command of their own.
        const stored = [
            { id: 'a', kind: 'reply' as const, label: 'Summarize', text: 'Summarize what changed.' },
            { id: 'b', kind: 'command' as const, label: 'Compact', text: '/compact' },
        ];
        expect(localSettingsParse({ terminalQuickActions: stored }).terminalQuickActions).toEqual(stored);

        // A device that only ever had the old insert-only snippets keeps what
        // it saw: the seeds it was shown unconditionally, then its own.
        const migrated = localSettingsParse({ terminalQuickReplies: [{ id: 'old', label: 'Ship it', text: 'Ship it when green.' }] }).terminalQuickActions;
        expect(migrated?.map((action) => action.label)).toEqual(['Continue', 'Run tests', 'Summarize', 'Ship it']);
        expect(migrated?.every((action) => action.kind === 'reply')).toBe(true);

        // A bad edit never strands the device: an over-cap or malformed list
        // falls back to the seeds, and costs nothing else that was stored.
        const over = Array.from({ length: QUICK_ACTION_LIMIT + 1 }, (_, i) => ({ id: `r${i}`, kind: 'reply', label: `r${i}`, text: 't' }));
        expect(localSettingsParse({ terminalQuickActions: over }).terminalQuickActions).toBeNull();
        const salvaged = localSettingsParse({ terminalQuickActions: [{ id: '', kind: 'nonsense', label: '', text: '' }], terminalFontIndex: 5 });
        expect(salvaged.terminalQuickActions).toBeNull();
        expect(salvaged.terminalFontIndex).toBe(5);
    });
});
