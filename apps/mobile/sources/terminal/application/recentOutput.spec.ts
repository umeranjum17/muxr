import { describe, expect, it } from 'vitest';
import { clearTerminalOutput, recordTerminalOutput, recentTerminalLinks } from './recentOutput';

const session = 'tui-links-spec';
const record = (text: string) => recordTerminalOutput(session, Buffer.from(text, 'utf8').toString('base64'));

describe('recentTerminalLinks across TUI repaints', () => {
    it('does not glue a row move onto the previous row URL', () => {
        clearTerminalOutput(session);
        // A TUI repaint that moves the cursor to another row instead of
        // printing a newline: without the row break the URL pattern eats
        // the next row's prose and the chip offers a wrong link.
        record('row https://example.com/deploy-notes\x1b[2;1Hmove along');
        expect(recentTerminalLinks(session)).toEqual(['https://example.com/deploy-notes']);
    });

    it('separates an erase from the previous row URL with a space', () => {
        clearTerminalOutput(session);
        record('row https://example.com/deploy-notes\x1b[2Kcleared');
        expect(recentTerminalLinks(session)).toEqual(['https://example.com/deploy-notes']);
    });
});
