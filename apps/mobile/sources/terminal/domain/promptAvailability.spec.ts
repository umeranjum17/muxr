import { describe, expect, it } from 'vitest';
import {
    DIALOG_GUARD_ACTION,
    DIALOG_GUARD_MESSAGE,
    DIALOG_GUARD_TITLE,
    pendingChoices,
    terminalComposerText,
    terminalInputDisposition,
} from './promptAvailability';

describe('terminal prompt guard', () => {
    it('sends a shell draft with its trailing space intact but trims agent prompts', () => {
        expect(terminalComposerText('echo iosqa\\ ', [], true)).toBe('echo iosqa\\ ');
        expect(terminalComposerText('echo iosqa\\ ', [], false)).toBe('echo iosqa\\');
        expect(terminalComposerText('   ', [], true)).toBe('');
        expect(terminalComposerText('   ', ['/tmp/photo'], true)).toBe('/tmp/photo');
        expect(terminalComposerText('echo iosqa\\ ', ['/tmp/photo'], true)).toBe('echo iosqa\\  /tmp/photo');
    });

    it('preserves literal punctuation in shell commands', () => {
        const typed = 'rm \'Proposal—final.pdf\' && printf “done” don\u2019t';
        expect(terminalComposerText(typed, [], true)).toBe(typed);
    });

    it('blocks unrelated input and exposes the one-line jump action', () => {
        expect(terminalInputDisposition(
            { agentStatus: 'blocked' },
            undefined,
            '/model',
        )).toEqual({ kind: 'blocked' });
        expect({ title: DIALOG_GUARD_TITLE, message: DIALOG_GUARD_MESSAGE, action: DIALOG_GUARD_ACTION }).toEqual({
            title: 'Dialog waiting',
            message: 'A dialog is waiting — answer it first, then send.',
            action: 'Show me the message',
        });
    });

    it('finds the answers a waiting agent offers, and only at the live edge', () => {
        // Claude Code asking at phone width: long choices wrap, the diff above
        // numbers its lines without a dot, and a footer sits under the choices.
        const claude = [
            ' Create file',
            ' .gitignore',
            '╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌',
            '  1 __pycache__/',
            '╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌',
            ' Do you want to create .gitignore?',
            ' ❯ 1. Yes',
            '   2. Yes, and switch to accept edits',
            '      (auto-approve file edits and',
            '      common file commands) for this',
            '      session (shift+tab)',
            '   3. No',
            '',
            ' Esc to cancel · Tab to amend',
        ].join('\n');
        expect(pendingChoices(claude)).toEqual([
            { key: '1', label: 'Yes' },
            { key: '2', label: 'Yes, and switch to accept edits (auto-approve file edits and common file commands) for this session (shift+tab)' },
            { key: '3', label: 'No' },
        ]);

        const codex = [
            '> You are in /tmp/project',
            '',
            '  Do you trust the contents of this directory?',
            '',
            '› 1. Yes, continue',
            '  2. No, quit',
            '',
            '  Press enter to continue',
        ].join('\n');
        expect(pendingChoices(codex)).toEqual([
            { key: '1', label: 'Yes, continue' },
            { key: '2', label: 'No, quit' },
        ]);
        expect(pendingChoices('❯ 1) Yes\n  2) No')).toEqual([]);
        expect(pendingChoices('▸ 1. Yes\n  2. No')).toEqual([]);
        expect(pendingChoices('  1. Yes\n  2. No\n  ▸ 3. Approve all')).toEqual([]);
        expect(pendingChoices('  1. Yes\n  2. No, and remember this\n     for this session\n Esc to cancel')).toEqual([
            { key: '1', label: 'Yes' },
            { key: '2', label: 'No, and remember this for this session' },
        ]);

        // A numbered list in the agent's own answer is not a question.
        const prose = [
            '● Next steps:',
            '  1. Add routes',
            '  2. Add tests',
            '',
            '✻ Crunched for 3s · done 6:32 AM',
            '  ✦ ultracode',
            '──────────── ultracode ─',
            '❯',
            '──────────────────',
            '  …/projects/notes-api master ?',
            '  ⏸ manual mode on',
        ].join('\n');
        expect(pendingChoices(prose)).toEqual([]);
    });

    it('passes a literal answer through the outstanding prompt guard', () => {
        expect(terminalInputDisposition(
            undefined,
            { agentState: { requests: { prompt: {} } } },
            'Y',
        )).toEqual({ kind: 'answer', answer: 'y' });
    });
});
