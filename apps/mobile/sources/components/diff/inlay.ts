/**
 * Lay a patch back into the file it came from.
 *
 * The Diff/File segmented control is desktop residue: on a phone the reader
 * wants one document that happens to show what changed. Given the new file
 * content and its unified patch, this produces a single row list where removed
 * lines are re-inserted in place and added lines are marked, so a diff and a
 * file are the same surface.
 *
 * Returns null when the patch does not describe this exact content — a stale
 * cache, CRLF, or a patch from another revision — and the caller falls back to
 * the hunk-only rows. Guessing would show the reader a lie.
 *
 * Pure on purpose — no React, no react-native — so it stays testable.
 */

export type InlayPrefix = ' ' | '+' | '-';

export interface InlayRow {
    prefix: InlayPrefix;
    text: string;
    /** 1-based line in the new file; undefined for a removed line. */
    newLine?: number;
    /** 1-based line in the old file; undefined for an added line. */
    oldLine?: number;
    /** Index of the hunk this row belongs to; -1 for untouched file content. */
    hunk: number;
}

export interface Hunk {
    oldStart: number;
    newStart: number;
    /** Lines the hunk covers in the new file, from the `@@` header. */
    newCount: number;
    lines: string[];
    context: string;
}

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/;

export function parseHunks(patch: string): Hunk[] {
    const hunks: Hunk[] = [];
    let current: Hunk | undefined;
    for (const raw of patch.split('\n')) {
        const header = HUNK_HEADER.exec(raw);
        if (header !== null) {
            current = {
                oldStart: Number(header[1]),
                newStart: Number(header[3]),
                newCount: header[4] === undefined ? 1 : Number(header[4]),
                lines: [],
                context: (header[5] ?? '').trim(),
            };
            hunks.push(current);
            continue;
        }
        if (current === undefined) continue;
        if (raw.startsWith('diff --git ')) {
            current = undefined;
            continue;
        }
        const first = raw.charAt(0);
        if (first === '+' || first === '-' || first === ' ') current.lines.push(raw);
        // `\ No newline at end of file` and stray blanks carry no row.
    }
    return hunks;
}

export interface Inlay {
    rows: InlayRow[];
    /** Row index of each hunk's first row, for stepping and the scrubber. */
    hunkRows: number[];
    hunkContext: string[];
}

export function inlay(code: string, patch: string): Inlay | null {
    const hunks = parseHunks(patch);
    if (hunks.length === 0) return null;
    const file = code.split('\n');
    const rows: InlayRow[] = [];
    const hunkRows: number[] = [];
    const hunkContext: string[] = [];
    let cursor = 0; // 0-based index into `file`

    for (let index = 0; index < hunks.length; index += 1) {
        const hunk = hunks[index]!;
        const start = hunk.newStart - 1;
        if (start < cursor || start > file.length) return null;
        for (let line = cursor; line < start; line += 1) {
            rows.push({ prefix: ' ', text: file[line] ?? '', newLine: line + 1, hunk: -1 });
        }
        cursor = start;
        hunkRows.push(rows.length);
        hunkContext.push(hunk.context);
        let oldLine = hunk.oldStart;
        for (const raw of hunk.lines) {
            const body = raw.slice(1);
            if (raw.charAt(0) === '-') {
                rows.push({ prefix: '-', text: body, oldLine, hunk: index });
                oldLine += 1;
                continue;
            }
            // Both context and added lines must be present in the new file at
            // the cursor; if they are not, the patch is not for this content.
            if (file[cursor] !== body) return null;
            rows.push(raw.charAt(0) === '+'
                ? { prefix: '+', text: body, newLine: cursor + 1, hunk: index }
                : { prefix: ' ', text: body, newLine: cursor + 1, oldLine, hunk: index });
            if (raw.charAt(0) === ' ') oldLine += 1;
            cursor += 1;
        }
    }
    for (let line = cursor; line < file.length; line += 1) {
        rows.push({ prefix: ' ', text: file[line] ?? '', newLine: line + 1, hunk: -1 });
    }
    return { rows, hunkRows, hunkContext };
}

/** Runs of untouched rows far enough from a change to be worth folding away. */
export interface FoldRun {
    start: number;
    /** Exclusive. */
    end: number;
}

/** difftastic merges novel lines closer than this, so a gap this small is never a fold. */
export const MAX_FOLD_DISTANCE = 4;
export const FOLD_CONTEXT = 3;

export function foldRuns(rows: InlayRow[], context = FOLD_CONTEXT): FoldRun[] {
    const keep = new Uint8Array(rows.length);
    for (let index = 0; index < rows.length; index += 1) {
        if (rows[index]!.hunk < 0) continue;
        for (let near = Math.max(0, index - context); near <= Math.min(rows.length - 1, index + context); near += 1) {
            keep[near] = 1;
        }
    }
    const runs: FoldRun[] = [];
    let start = -1;
    for (let index = 0; index <= rows.length; index += 1) {
        const folded = index < rows.length && keep[index] === 0;
        if (folded && start < 0) start = index;
        if (!folded && start >= 0) {
            if (index - start > MAX_FOLD_DISTANCE) runs.push({ start, end: index });
            start = -1;
        }
    }
    return runs;
}
