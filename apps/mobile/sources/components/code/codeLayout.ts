/**
 * Monospace layout arithmetic for the code and diff viewers.
 *
 * React Native cannot indent or mark the second row of a soft-wrapped `Text`,
 * so nothing here is ever allowed to wrap: a logical line is split into visual
 * rows up front and each row is rendered as its own single-line `Text`. That
 * makes the hanging indent, the continuation glyph and the row heights all
 * computable, which is what lets the lists virtualize.
 *
 * Pure on purpose — no React, no react-native — so it stays testable.
 */

import type { SyntaxSpan } from '@/components/code/syntaxHighlighting';

export const TAB_SIZE = 4;
export const CHAR_WIDTH_RATIO = 0.6;
export const GAP = 8;
export const RIGHT_INSET = 8;
export const NUMBER_CELL_PADDING = 6;
export const MARKER_CELL_PADDING = 4;
export const DIFF_BORDER = 2;
export const MIN_FONT_SIZE = 12;
export const MAX_FONT_SIZE = 14;
export const TARGET_COLUMNS = 64;
/** Continuation rows keep at least this much room, however deep the original indent. */
export const MIN_CONTINUATION_COLUMNS = 16;
/** Only the tail of a row may be given back to reach a token boundary. */
export const BREAK_WINDOW = 0.4;

/**
 * A soft-wrapped row is marked by its hanging indent and nothing else, the way
 * every editor does it. A glyph in the margin of every wrapped line reads as a
 * rendering fault rather than as a wrap.
 */
export const CONTINUATION_HANG = 4;

const AFTER_BREAK: Record<string, true> = { ' ': true, ',': true, ';': true, ')': true, ']': true, '}': true, '>': true };
const BEFORE_BREAK: Record<string, true> = {
    '(': true, '[': true, '{': true, '.': true, '=': true, '?': true, ':': true,
    '+': true, '-': true, '*': true, '/': true, '&': true, '|': true, '<': true,
};

/**
 * Display cells for one code point: 2 for the East Asian Wide and Fullwidth
 * blocks, 0 for combining marks and zero-width joiners, 1 for everything else.
 */
export function cellWidth(codePoint: number): number {
    if (codePoint >= 0x0300 && codePoint <= 0x036f) return 0;
    if (codePoint >= 0x200b && codePoint <= 0x200d) return 0;
    if (codePoint === 0xfe0f) return 0;
    if (codePoint >= 0x1100 && codePoint <= 0x115f) return 2;
    if (codePoint >= 0x2e80 && codePoint <= 0xa4cf) return 2;
    if (codePoint >= 0xac00 && codePoint <= 0xd7a3) return 2;
    if (codePoint >= 0xf900 && codePoint <= 0xfaff) return 2;
    if (codePoint >= 0xfe30 && codePoint <= 0xfe4f) return 2;
    if (codePoint >= 0xff00 && codePoint <= 0xff60) return 2;
    if (codePoint >= 0xffe0 && codePoint <= 0xffe6) return 2;
    if (codePoint >= 0x1f300 && codePoint <= 0x1faff) return 2;
    return 1;
}

export function expandTabs(text: string): string {
    if (!text.includes('\t')) return text;
    let out = '';
    for (const character of text) {
        if (character !== '\t') {
            out += character;
            continue;
        }
        out += ' '.repeat(TAB_SIZE - (out.length % TAB_SIZE));
    }
    return out;
}

/**
 * The same expansion applied to highlighted spans, so span offsets and plain
 * offsets index the same string and a break lands in the same place in both.
 */
export function expandSpanTabs(spans: SyntaxSpan[]): SyntaxSpan[] {
    if (!spans.some((span) => span.text.includes('\t'))) return spans;
    let column = 0;
    return spans.map((span) => {
        let text = '';
        for (const character of span.text) {
            if (character === '\t') {
                const pad = TAB_SIZE - (column % TAB_SIZE);
                text += ' '.repeat(pad);
                column += pad;
                continue;
            }
            text += character;
            column += 1;
        }
        return span.type === undefined ? { text } : { text, type: span.type };
    });
}

function leadingSpaces(text: string): number {
    let count = 0;
    while (count < text.length && text.charCodeAt(count) === 32) count += 1;
    return count;
}

function isBreakOpportunity(text: string, at: number): boolean {
    return AFTER_BREAK[text.charAt(at - 1)] === true || BEFORE_BREAK[text.charAt(at)] === true;
}

/**
 * Index where the row starting at `from` should end. Fills the budget, then
 * gives back at most the final 40 percent to land on a token boundary; a URL
 * or a hash with no boundary in that window is hard-broken at the budget.
 */
function nextBreak(text: string, from: number, budget: number): number {
    let used = 0;
    let index = from;
    let candidate = -1;
    const floor = Math.ceil(budget * (1 - BREAK_WINDOW));
    while (index < text.length) {
        const codePoint = text.codePointAt(index)!;
        const width = cellWidth(codePoint);
        if (used + width > budget) break;
        used += width;
        const next = index + (codePoint > 0xffff ? 2 : 1);
        if (used >= floor && next < text.length && isBreakOpportunity(text, next)) candidate = next;
        index = next;
    }
    if (index >= text.length) return text.length;
    // A budget under one cell would not advance; hard-break instead of looping.
    if (index === from) return from + (text.codePointAt(from)! > 0xffff ? 2 : 1);
    return candidate > from ? candidate : index;
}

export interface LineLayout {
    /** Start index of each visual row in the tab-expanded line; always begins with 0. */
    starts: number[];
    /** Continuation indent in cells. */
    hang: number;
}

export function layoutLine(expanded: string, cols: number): LineLayout {
    const usable = Math.max(1, cols);
    const hang = Math.min(leadingSpaces(expanded) + CONTINUATION_HANG, Math.max(0, usable - MIN_CONTINUATION_COLUMNS));
    const starts = [0];
    let at = nextBreak(expanded, 0, usable);
    while (at < expanded.length) {
        starts.push(at);
        at = nextBreak(expanded, at, Math.max(1, usable - hang));
    }
    return { starts, hang };
}

/** Row counts for every line, for the list's prefix sums. */
export function layoutLines(lines: string[], cols: number): LineLayout[] {
    return lines.map((line) => layoutLine(expandTabs(line), cols));
}

/**
 * Cut highlighted spans at the row boundaries, preserving `type`, so colour
 * survives a break.
 */
export function sliceSpans(spans: SyntaxSpan[], starts: number[]): SyntaxSpan[][] {
    const expanded = expandSpanTabs(spans);
    if (starts.length <= 1) return [expanded];
    const rows: SyntaxSpan[][] = starts.map(() => []);
    let row = 0;
    let offset = 0;
    for (const span of expanded) {
        let consumed = 0;
        while (consumed < span.text.length) {
            const nextStart = row + 1 < starts.length ? starts[row + 1]! : Infinity;
            const take = Math.min(span.text.length - consumed, nextStart - (offset + consumed));
            if (take > 0) {
                const text = span.text.slice(consumed, consumed + take);
                rows[row]!.push(span.type === undefined ? { text } : { text, type: span.type });
                consumed += take;
            }
            if (offset + consumed >= nextStart) row += 1;
        }
        offset += span.text.length;
    }
    return rows;
}

/** Columns that fit; the half-character margin keeps hinting from clipping the last glyph. */
export function columnsFor(codeWidth: number, charWidth: number): number {
    return Math.max(1, Math.floor((codeWidth - charWidth / 2) / charWidth));
}

/**
 * Clip to a cell budget, not a character count: a pin label full of wide
 * glyphs would otherwise still overflow and scroll its field.
 */
export function clipToCells(text: string, cols: number): string {
    let cells = 0;
    let index = 0;
    while (index < text.length) {
        const codePoint = text.codePointAt(index)!;
        const width = cellWidth(codePoint);
        if (cells + width > cols) return text.slice(0, index);
        cells += width;
        index += codePoint > 0xffff ? 2 : 1;
    }
    return text;
}

export function fileGutterWidth(digits: number, charWidth: number): number {
    return digits * charWidth + NUMBER_CELL_PADDING;
}

export function diffGutterWidth(digits: number, numberCharWidth: number, markerCharWidth: number): number {
    return 2 * (digits * numberCharWidth + NUMBER_CELL_PADDING) + (markerCharWidth + MARKER_CELL_PADDING) + DIFF_BORDER;
}

/**
 * Type size follows the width of the pane, never the content: deriving it from
 * the longest line makes the size jump between files and shrinks a minified
 * file into illegibility. Aim for 64 columns, clamp to a readable band.
 */
export function deriveFontSize(
    contentWidth: number,
    digits: number,
    kind: 'file' | 'diff',
    charWidth: (size: number) => number,
): number {
    for (let size = MAX_FONT_SIZE; size > MIN_FONT_SIZE; size -= 1) {
        const gutter = kind === 'file'
            ? fileGutterWidth(digits, charWidth(size - 1))
            : diffGutterWidth(digits, charWidth(size - 1), charWidth(size));
        const codeWidth = contentWidth - gutter - GAP - RIGHT_INSET;
        if (Math.floor(codeWidth / (CHAR_WIDTH_RATIO * TARGET_COLUMNS)) >= size) return size;
    }
    return MIN_FONT_SIZE;
}

export function lineHeightFor(fontSize: number): number {
    return Math.round(fontSize * 1.5);
}

/** Running offsets for `getItemLayout`, plus the total. */
export function prefixSums(heights: number[]): number[] {
    const offsets = new Array<number>(heights.length + 1);
    offsets[0] = 0;
    for (let index = 0; index < heights.length; index += 1) offsets[index + 1] = offsets[index]! + heights[index]!;
    return offsets;
}
