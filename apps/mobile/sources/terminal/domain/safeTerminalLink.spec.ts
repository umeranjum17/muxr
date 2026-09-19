import { describe, expect, it, vi } from 'vitest';
import xterm from '@xterm/xterm';
import { joinedTerminalUrlAt, lineCellMap, openTerminalLink, plainLinkAtCell, safeTerminalLinkUrl, terminalUrlAt, type TerminalLinkRow } from './safeTerminalLink';

/**
 * One flow: a link the terminal printed (plain text or OSC 8) travels through
 * the safe-open boundary to the browser. Everything a user actually taps or
 * copies rides this single function, so the flow test drives it with real
 * printed output shapes and asserts what reaches the open boundary.
 */
describe('terminal printed links open only as safe web URLs', () => {
    it('opens plain and OSC 8 web links through the boundary, drops every other scheme, and never mutates the exact URL', () => {
        const open = vi.fn<(url: string) => Promise<void>>().mockResolvedValue(undefined);
        const tap = (raw: string) => {
            openTerminalLink(raw, open);
        };

        // Plain http/https printed in output — forwarded byte-exact.
        tap('https://example.com/docs/r/1?a=b#section');
        tap('https://example.test/osc8'); // OSC 8 carries its own URI — same boundary, same verdict.
        expect(open.mock.calls.map(([url]) => url)).toEqual([
            'https://example.com/docs/r/1?a=b#section',
            'https://example.test/osc8',
        ]);

        // Executable, file, javascript, data and unknown schemes never reach a
        // handler; terminal output is untrusted.
        open.mockClear();
        for (const raw of [
            'file:///etc/passwd',
            'javascript:alert(document.cookie)',
            'data:text/html,<script>fetch("/")</script>',
            'ssh://host.example.internal',
            'market://details?id=com.example',
            'http://', // no host
            'not a url',
            '',
        ]) {
            tap(raw);
        }
        expect(open).not.toHaveBeenCalled();

        // A session may print enormous junk; the boundary caps what it will open.
        expect(safeTerminalLinkUrl(`https://example.com/${'x'.repeat(4000)}`)).toBeNull();

        // Long-press copy extracts the exact link the finger is on: full
        // query/fragment kept, trailing punctuation never joins it, a wrapped
        // URL joined into one string copies as one link, and text that is not
        // a link (including non-web schemes) copies nothing.
        expect(terminalUrlAt('see https://example.com/a?b=c#d.', 5)).toBe('https://example.com/a?b=c#d');
        expect(terminalUrlAt('https://example.com/a, then https://other.test/x', 0)).toBe('https://example.com/a');
        const wrapped = 'https://example.com/very/long' + '/path/with/query?x=1';
        expect(terminalUrlAt(' ' + wrapped + ' ', 4)).toBe(wrapped);
        expect(terminalUrlAt('plain terminal text', 5)).toBeNull();
        expect(terminalUrlAt('open ssh://git@host:22/repo.git now', 6)).toBeNull();
    });

    it('joins a URL across soft-wrapped rows and never across a hard new line', () => {
        const rows = (wrap: boolean): ((row: number) => TerminalLinkRow | undefined) => {
            const list: TerminalLinkRow[] = [
                { text: 'https://example.com/very/long/path/that/fills/the/width/aaaa', isWrapped: false },
                wrap
                    ? { text: 'bbbb/ccc?d=1', isWrapped: true }
                    : { text: 'Notes:', isWrapped: false },
            ];
            return (row) => list[row];
        };
        const full = 'https://example.com/very/long/path/that/fills/the/width/aaaa';

        // Hard new line below a full-width URL: the URL stays whole and the
        // word under the finger on the next line is not a link.
        expect(joinedTerminalUrlAt(rows(false), 0, 10)).toBe(full);
        expect(joinedTerminalUrlAt(rows(false), 1, 0)).toBeNull();

        // Soft-wrapped continuation: both rows resolve the same joined link.
        expect(joinedTerminalUrlAt(rows(true), 0, 10)).toBe(`${full}bbbb/ccc?d=1`);
        expect(joinedTerminalUrlAt(rows(true), 1, 0)).toBe(`${full}bbbb/ccc?d=1`);
    });

    it('maps long-press cells through the same string xterm renders, wide glyphs included', async () => {
        const term = new xterm.Terminal({ cols: 20, rows: 2 });
        await new Promise<void>((resolve) => term.write('中文 https://a.io', resolve));
        const line = term.buffer.active.getLine(0)!;
        const rowAt = (): TerminalLinkRow => ({ text: line.translateToString(true), isWrapped: false });

        // The walk sees exactly the string xterm renders: the zero-width cell
        // after each wide glyph contributes nothing, so cells and string units
        // stay aligned and both surfaces resolve the same link.
        expect(lineCellMap(line, 20).text).toBe(line.translateToString(false));
        expect(plainLinkAtCell(line, 20, 16, 0, rowAt)).toBe('https://a.io');
        expect(plainLinkAtCell(line, 20, 5, 0, rowAt)).toBe('https://a.io');
        expect(plainLinkAtCell(line, 20, 4, 0, rowAt)).toBeNull();
        expect(plainLinkAtCell(line, 20, 1, 0, rowAt)).toBeNull();
        term.dispose();
    });
});
