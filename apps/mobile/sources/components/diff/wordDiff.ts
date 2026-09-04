/**
 * Word-level change ranges between a removed line and the added line that
 * replaced it.
 *
 * A line diff tells you a line changed; a word diff tells you what changed in
 * it, which on a phone is the difference between reading the line and scanning
 * it. Pure on purpose - no React - so it stays testable.
 */

import type { SyntaxSpan } from '@/components/code/syntaxHighlighting';

export interface Range {
    start: number;
    /** Exclusive. */
    end: number;
}

/** Identifier runs, whitespace runs, and every other character on its own. */
function tokenize(text: string): string[] {
    const out: string[] = [];
    let at = 0;
    while (at < text.length) {
        const code = text.charCodeAt(at);
        const word = (code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || code === 95 || code === 36;
        const space = code === 32 || code === 9;
        if (!word && !space) {
            out.push(text.charAt(at));
            at += 1;
            continue;
        }
        let end = at + 1;
        while (end < text.length) {
            const next = text.charCodeAt(end);
            const nextWord = (next >= 48 && next <= 57) || (next >= 65 && next <= 90) || (next >= 97 && next <= 122) || next === 95 || next === 36;
            const nextSpace = next === 32 || next === 9;
            if (word ? !nextWord : !nextSpace) break;
            end += 1;
        }
        out.push(text.slice(at, end));
        at = end;
    }
    return out;
}

/** Merge touching ranges so one highlight covers `foo.bar` rather than three. */
function coalesce(ranges: Range[]): Range[] {
    const out: Range[] = [];
    for (const range of ranges) {
        if (range.end <= range.start) continue;
        const last = out[out.length - 1];
        if (last !== undefined && range.start <= last.end) {
            last.end = Math.max(last.end, range.end);
            continue;
        }
        out.push({ ...range });
    }
    return out;
}

/**
 * Common prefix and suffix, then everything between them is the change. This
 * is what git's `--word-diff` shows for the overwhelmingly common edit - a
 * rename, a changed argument, a flipped operator - without the quadratic cost
 * of a real token LCS on lines that can be thousands of characters wide.
 */
export function wordRanges(removed: string, added: string): { removed: Range[]; added: Range[] } | null {
    if (removed === added) return null;
    const before = tokenize(removed);
    const after = tokenize(added);
    let head = 0;
    while (head < before.length && head < after.length && before[head] === after[head]) head += 1;
    let tail = 0;
    while (
        tail < before.length - head
        && tail < after.length - head
        && before[before.length - 1 - tail] === after[after.length - 1 - tail]
    ) tail += 1;

    // Two lines that share nothing are a replacement, not an edit; highlighting
    // every token would be the same as highlighting none.
    const shared = head + tail;
    if (shared === 0) return null;

    const span = (tokens: string[]): Range[] => {
        const start = tokens.slice(0, head).join('').length;
        const end = tokens.length - tail === head
            ? start
            : tokens.slice(0, tokens.length - tail).join('').length;
        return coalesce([{ start, end }]);
    };
    const result = { removed: span(before), added: span(after) };
    if (result.removed.length === 0 && result.added.length === 0) return null;
    return result;
}

/** Split spans at the range edges and mark the pieces that fall inside one. */
export function markSpans(spans: SyntaxSpan[], ranges: Range[]): SyntaxSpan[] {
    if (ranges.length === 0) return spans;
    const out: SyntaxSpan[] = [];
    let offset = 0;
    for (const span of spans) {
        const start = offset;
        const end = offset + span.text.length;
        offset = end;
        let at = start;
        for (const range of ranges) {
            if (range.end <= at || range.start >= end) continue;
            const from = Math.max(at, range.start);
            const to = Math.min(end, range.end);
            if (from > at) out.push({ ...span, text: span.text.slice(at - start, from - start) });
            out.push({ ...span, text: span.text.slice(from - start, to - start), mark: true });
            at = to;
        }
        if (at < end) out.push({ ...span, text: span.text.slice(at - start) });
    }
    return out;
}
