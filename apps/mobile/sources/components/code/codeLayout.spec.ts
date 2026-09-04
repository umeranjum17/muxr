import { describe, expect, it } from 'vitest';
import {
    cellWidth,
    columnsFor,
    deriveFontSize,
    expandTabs,
    layoutLine,
    lineHeightFor,
    sliceSpans,
} from '@/components/code/codeLayout';
import type { SyntaxSpan } from '@/components/code/syntaxHighlighting';

/**
 * The viewers render every visual row as its own single-line Text, so a row
 * that overflows its budget is clipped with no affordance and a span sliced at
 * the wrong index recolours the code. This drives one real line through the
 * whole split — tabs, budget, hanging indent, token boundary, spans — the way
 * CodeCore and the diff do.
 */

function widthInCells(text: string): number {
    let cells = 0;
    for (const character of text) cells += cellWidth(character.codePointAt(0)!);
    return cells;
}

function rowsOf(spans: SyntaxSpan[], cols: number): { text: string; cells: number }[] {
    const expanded = expandTabs(spans.map((span) => span.text).join(''));
    const layout = layoutLine(expanded, cols);
    return sliceSpans(spans, layout.starts).map((row, index) => ({
        text: row.map((span) => span.text).join(''),
        // A continuation row is indented by `hang`, so its own budget is smaller.
        cells: widthInCells(row.map((span) => span.text).join('')) + (index === 0 ? 0 : layout.hang),
    }));
}

describe('code layout', () => {
    it('splits a real indented line into rows that fit, keep their spans and hang under the code', () => {
        const spans: SyntaxSpan[] = [
            { text: '\t\t' },
            { text: 'const', type: 'keyword' },
            { text: ' gutterWidth = ' },
            { text: 'digits', type: 'function' },
            { text: ' * charWidth(size - 1) + NUMBER_CELL_PADDING + extraPaddingForTheGutter;' },
        ];
        const cols = 40;
        const rows = rowsOf(spans, cols);

        expect(rows.length).toBeGreaterThan(1);
        // Nothing may exceed the budget: an over-long row is clipped on screen.
        for (const row of rows) expect(row.cells).toBeLessThanOrEqual(cols);
        // The text is preserved exactly, tabs expanded, nothing inserted.
        expect(rows.map((row) => row.text).join('')).toBe(
            '        const gutterWidth = digits * charWidth(size - 1) + NUMBER_CELL_PADDING + extraPaddingForTheGutter;',
        );
        // A break never lands inside a word: the row before ends on a boundary.
        const joined = rows.map((row) => row.text);
        for (let index = 1; index < joined.length; index += 1) {
            const before = joined[index - 1]!.slice(-1);
            const after = joined[index]!.charAt(0);
            expect(/\w/.test(before) && /\w/.test(after)).toBe(false);
        }
        // Colour survives the break: the keyword is still its own span.
        expect(rows[0]!.text).toContain('const');
        expect(sliceSpans(spans, layoutLine(expandTabs(spans.map((s) => s.text).join('')), cols).starts)[0]!
            .some((span) => span.type === 'keyword')).toBe(true);
    });

    it('hard-breaks a token with no boundary and never loops', () => {
        const hash = 'a'.repeat(200);
        const rows = rowsOf([{ text: hash }], 40);
        expect(rows.length).toBeGreaterThan(4);
        expect(rows.map((row) => row.text).join('')).toBe(hash);
    });

    it('counts wide and zero-width characters as the terminal does', () => {
        expect(widthInCells('日本語')).toBe(6);
        expect(widthInCells('e\u0301')).toBe(1);
        const rows = rowsOf([{ text: '日'.repeat(40) }], 20);
        for (const row of rows) expect(row.cells).toBeLessThanOrEqual(20);
    });

    it('derives 12 dp and about 49 columns on the 411 dp emulator', () => {
        const charWidth = (size: number) => 0.6 * size;
        // 411 dp window, 8 dp insets on a narrow pane. 12 dp at 1.5 is the
        // appearance spec: seven columns traded for code that looks like code,
        // since wrapping already carries a long line.
        const contentWidth = 411 - 16;
        expect(deriveFontSize(contentWidth, 3, 'file', charWidth)).toBe(12);
        expect(lineHeightFor(12)).toBe(18);
        // One column, 16 dp of body padding each side, no number gutter.
        expect(columnsFor(contentWidth - 32, charWidth(12))).toBe(49);
        // A tablet gets the ceiling size instead of the floor.
        expect(deriveFontSize(700 - 32, 3, 'file', charWidth)).toBe(14);
    });
});
