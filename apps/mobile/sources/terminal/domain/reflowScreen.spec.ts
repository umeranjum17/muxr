import { describe, expect, it } from 'vitest';
import { reflowScreen } from './reflowScreen';

// An agent lays its transcript out at the pane's width: messages word-wrapped
// with a hanging indent, the prompt between two full-width rules. The pager
// shows a neighbour's desk-width screen before the phone attaches, and has to
// look like the redraw the agent makes once the pane is at the phone's width.
const MESSAGES = [
    "⏺ I'm outlining the sections and decision forms: title and summary at the top, review instructions, then twelve sections covering positioning.",
    '⏺ Next I am sketching the README mock as a GitHub-style dark theme at phone width with a mascot header, hero video and a feature index.',
    '  ⎿  Read 3 files',
];

function agentScreen(columns: number): string {
    const lines: string[] = [];
    for (const message of MESSAGES) {
        const indent = message.length - message.trimStart().length;
        let line = '';
        for (const word of message.trimStart().split(' ')) {
            if (line !== '' && line.length + 1 + word.length > columns) {
                lines.push(line);
                line = ' '.repeat(indent + 2) + word;
            } else {
                line = line === '' ? ' '.repeat(indent) + word : `${line} ${word}`;
            }
        }
        lines.push(line, '');
    }
    return [...lines, '─'.repeat(columns), '>', '─'.repeat(columns), '  ? for shortcuts'].join('\n');
}

describe('a desk-width screen set at the phone width', () => {
    it('reads as the agent will redraw it, from a narrower and from a wider desk', () => {
        const phone = agentScreen(56).split('\n');
        expect(reflowScreen(agentScreen(30), 56)).toEqual(phone);
        expect(reflowScreen(agentScreen(96), 56)).toEqual(phone);
    });

    it('leaves short lines apart when the screen does not show its width', () => {
        const shell = '$ ls\nREADME.md\nsrc\n$ git status\nnothing to commit';
        expect(reflowScreen(shell, 40)).toEqual(shell.split('\n'));
    });
});
