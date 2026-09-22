import { beforeEach, describe, expect, it } from 'vitest';
import { appendToDraft, clearDraftInsertion, consumeDraftInsertion, requestDraftInsertion } from './draftInsertion';
import { quickActionCommand } from './quickActionCommands';
import { quickActionErrors, resolveQuickActions, QUICK_ACTION_LABEL_LIMIT, QUICK_ACTION_LIMIT, QUICK_ACTION_TEXT_LIMIT, type QuickAction } from '../domain/quickActions';
import type { AgentCommand } from '../domain/agentCommands';
import { localSettingsParse } from '@/catalog/application/localSettings';

/**
 * Safe draft reuse, end to end at the logic level: a line picked in history
 * rides the one-shot handoff into a mounted terminal's nonempty draft with its
 * exact bytes, a stale or vanished target drops it, and nothing in that path
 * can send — only an explicit Send ever touches the wire. Quick actions are
 * the deliberate exception: a tap sends whatever the text holds, and only a
 * destructive command asks first.
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

    it('sends on a tap whatever the text holds, and asks first only for a destructive command', () => {
        const calls: string[] = [];
        const palette = {
            agentKind: 'claude',
            sentHint: (label: string) => calls.push(`hint:${label}`),
            send: (text: string) => calls.push(`send:${text}`),
            confirmDangerous: (entry: AgentCommand) => calls.push(`confirm:${entry.command}`),
            insert: (text: string) => calls.push(`insert:${text}`),
        };
        const row = (action: QuickAction): ReturnType<typeof quickActionCommand> => quickActionCommand(action, 'Common replies', palette);

        // Braces are ordinary text: a tap sends the action, it never fills.
        row({ id: 'a', kind: 'reply', label: 'Review', text: 'Review {file} and report back.' }).action();
        expect(calls).toEqual(['hint:Review', 'send:Review {file} and report back.']);

        // A personal action naming a destructive command is the catalogue row
        // for it: marked destructive, and confirmed before anything is sent.
        calls.length = 0;
        const clear = row({ id: 'b', kind: 'command', label: 'Clear', text: '/clear' });
        expect(clear.destructive).toBe(true);
        clear.action();
        expect(calls).toEqual(['confirm:/clear']);

        // An ordinary command still goes out on the first tap.
        calls.length = 0;
        row({ id: 'c', kind: 'command', label: 'Compact', text: '/compact' }).action();
        expect(calls).toEqual(['hint:Compact', 'send:/compact']);
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

        // A device that only ever had the old insert-only snippets keeps every
        // entry of its own, and the seeds fill only the room left over rather
        // than pushing the person's last entries off the end.
        const migrated = localSettingsParse({ terminalQuickReplies: [{ id: 'old', label: 'Ship it', text: 'Ship it when green.' }] }).terminalQuickActions;
        expect(migrated?.map((action) => action.label)).toEqual(['Ship it', 'Continue', 'Run tests', 'Summarize']);
        expect(migrated?.every((action) => action.kind === 'reply')).toBe(true);

        // A device at the old cap keeps all of its own entries and none of the
        // seeds: losing the person's own data to make room for the seeds would
        // be unrecoverable once the next write replaces the legacy list.
        const legacy = Array.from({ length: QUICK_ACTION_LIMIT }, (_, i) => ({ id: `old${i}`, label: `old${i}`, text: 't' }));
        const atCap = localSettingsParse({ terminalQuickReplies: legacy }).terminalQuickActions;
        expect(atCap).toHaveLength(QUICK_ACTION_LIMIT);
        expect(atCap?.map((action) => action.id)).toEqual(legacy.map((entry) => entry.id));
        expect(atCap?.some((action) => action.id.startsWith('seed-'))).toBe(false);

        // A bad edit never strands the device: an over-cap or malformed list
        // falls back to the seeds, and costs nothing else that was stored.
        const over = Array.from({ length: QUICK_ACTION_LIMIT + 1 }, (_, i) => ({ id: `r${i}`, kind: 'reply', label: `r${i}`, text: 't' }));
        expect(localSettingsParse({ terminalQuickActions: over }).terminalQuickActions).toBeNull();
        const salvaged = localSettingsParse({ terminalQuickActions: [{ id: '', kind: 'nonsense', label: '', text: '' }], terminalFontIndex: 5 });
        expect(salvaged.terminalQuickActions).toBeNull();
        expect(salvaged.terminalFontIndex).toBe(5);
    });
});
