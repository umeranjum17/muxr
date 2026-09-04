/**
 * Scope detection from indentation and the Prism token stream.
 *
 * VS Code's sticky scroll falls back to `IndentRangeProvider.computeRanges`
 * when no document-symbol provider answers; that fallback is the whole reason
 * a pinned scope is reachable here, because this app has no language server
 * and no tree-sitter. Everything below is indentation plus a look at the
 * tokens the highlighter already produced.
 *
 * Pure on purpose — no React, no react-native — so it stays testable.
 */

import { TAB_SIZE, expandTabs } from '@/components/code/codeLayout';
import type { SyntaxSpan } from '@/components/code/syntaxHighlighting';

/** A line this shallow can still open a scope worth pinning. */
export const MAX_OPENER_INDENT_CELLS = 8;
/** Pins on a phone; a third only earns its 24 dp on a tablet. */
export const PHONE_PIN_COUNT = 2;
export const TABLET_PIN_COUNT = 3;

const DECLARING_KEYWORDS: Record<string, true> = {
    function: true, class: true, def: true, fn: true, func: true, impl: true,
    struct: true, interface: true, enum: true, trait: true, module: true,
    namespace: true, type: true, object: true, fun: true,
};

/** Control flow opens a block but is never what you have "lost track of". */
const CONTROL_KEYWORDS: Record<string, true> = {
    if: true, else: true, for: true, while: true, do: true, switch: true,
    case: true, try: true, catch: true, finally: true, with: true,
    return: true, throw: true,
};

const ARROW_BINDING = /^\s*(?:export\s+)?(?:const|let|var)\s+\w+\s*=\s*(?:async\s*)?(?:\([^)]*\)|\w+)\s*=>/;
const TEST_BLOCK = /^\s*(?:describe|it|test)\s*\(/;
const BRACE_TAIL = /(?:\{|\(|:|=>\s*\{)\s*$/;

const WORD = /[A-Za-z_][A-Za-z0-9_]*/;

export function indentCells(line: string): number {
    const expanded = expandTabs(line);
    let cells = 0;
    while (cells < expanded.length && expanded.charCodeAt(cells) === 32) cells += 1;
    return cells === expanded.length ? -1 : cells;
}

function firstWord(line: string): string {
    return WORD.exec(line)?.[0] ?? '';
}

/**
 * Does this line open a scope a reader would want pinned? Prism types decide
 * when a grammar exists; a brace-ish tail is the fallback when it does not.
 */
export function isScopeOpener(line: string, spans: SyntaxSpan[] | undefined): boolean {
    const indent = indentCells(line);
    if (indent < 0 || indent > MAX_OPENER_INDENT_CELLS) return false;
    if (CONTROL_KEYWORDS[firstWord(line.trimStart())] === true) return false;
    // A JSX tag is a `class-name` to Prism and opens a block to the indenter,
    // so both signals fire on `<View style={...}>`. Nobody wants `<View` as the
    // answer to "where am I"; measured at 6 of 20 entries before this guard.
    if (line.trimStart().startsWith('<')) return false;
    if (ARROW_BINDING.test(line) || TEST_BLOCK.test(line)) return true;
    if (spans === undefined || spans.length === 0) return BRACE_TAIL.test(line);
    let typed = false;
    for (const span of spans) {
        if (span.type === undefined) continue;
        typed = true;
        if (span.type === 'keyword' && DECLARING_KEYWORDS[span.text.trim()] === true) return true;
    }
    return typed ? false : BRACE_TAIL.test(line);
}

export interface ScopeModel {
    /** Line indices that open a scope, ascending. */
    openers: number[];
    /** Pairs `(outermost, innermost)` enclosing each line; -1 for none. */
    enclosing: Int32Array;
    /** Indent cells per line; -1 for blank. */
    indents: Int32Array;
}

/**
 * One pass: indentation, openers, and the enclosing pair per line. A line is
 * inside an opener when that opener sits above it at a strictly smaller
 * indent, which is the same rule the fold ranges use.
 */
export function buildScopeModel(lines: string[], highlighted: SyntaxSpan[][]): ScopeModel {
    const count = lines.length;
    const indents = new Int32Array(count);
    for (let index = 0; index < count; index += 1) indents[index] = indentCells(lines[index] ?? '');

    const openers: number[] = [];
    const enclosing = new Int32Array(count * 2).fill(-1);
    const stack: number[] = [];
    for (let index = 0; index < count; index += 1) {
        // A blank line belongs to whatever the next real line belongs to, so
        // the pin does not flicker across paragraph breaks.
        let indent = indents[index]!;
        if (indent < 0) {
            let ahead = index + 1;
            while (ahead < count && indents[ahead]! < 0) ahead += 1;
            indent = ahead < count ? indents[ahead]! : 0;
        }
        while (stack.length > 0 && indents[stack[stack.length - 1]!]! >= indent) stack.pop();
        enclosing[index * 2] = stack[0] ?? -1;
        enclosing[index * 2 + 1] = stack[stack.length - 1] ?? -1;
        if (indents[index]! < 0) continue;
        if (!isScopeOpener(lines[index] ?? '', highlighted[index])) continue;
        // An opener with nothing nested under it is a declaration, not a scope.
        let next = index + 1;
        while (next < count && indents[next]! < 0) next += 1;
        if (next >= count || indents[next]! <= indents[index]!) continue;
        openers.push(index);
        stack.push(index);
    }
    return { openers, enclosing, indents };
}

export interface OutlineEntry {
    line: number;
    indent: number;
    label: string;
}

/** The jump sheet's rows: opener text, trimmed, with its nesting preserved. */
export function outlineEntries(lines: string[], model: ScopeModel, limit = 200): OutlineEntry[] {
    const entries: OutlineEntry[] = [];
    for (const line of model.openers) {
        if (entries.length >= limit) break;
        const text = (lines[line] ?? '').trim();
        if (text === '') continue;
        entries.push({ line, indent: model.indents[line] ?? 0, label: text.length > 80 ? `${text.slice(0, 79)}…` : text });
    }
    return entries;
}
