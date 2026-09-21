import { describe, expect, it } from 'vitest';
import { personalReplyCommands, type PersonalQuickReply } from './quickReplies';

/**
 * Reachability of the person's own replies in the command palette: a saved
 * reply must surface as exactly one insert-only command carrying its label
 * and text. A regression here strands the reply in the editor with no way to
 * use it, which is how the reachability defect read from the terminal.
 */

const reply = (overrides: Partial<PersonalQuickReply> = {}): PersonalQuickReply => ({
    id: 'r1',
    label: 'Ship it',
    text: 'Ship the current branch and report the diff summary.',
    ...overrides,
});

describe('personal reply reachability', () => {
    it('projects every saved reply as an insert-only palette command', () => {
        const commands = personalReplyCommands([
            reply(),
            reply({ id: 'r2', label: 'Run tests', text: 'Run the relevant tests.' }),
        ]);

        expect(commands).toHaveLength(2);
        expect(commands[0]).toMatchObject({
            id: 'reply:user:r1',
            title: 'Ship it',
            text: 'Ship the current branch and report the diff summary.',
            insertOnly: true,
        });
        expect(commands[1]?.id).toBe('reply:user:r2');
        // Ids are stable per reply, so a reorder cannot break palette dedupe.
        expect(commands[0]?.id).not.toBe(commands[1]?.id);
    });

    it('keeps the empty list empty and never invents commands', () => {
        expect(personalReplyCommands([])).toEqual([]);
    });
});
