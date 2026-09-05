/**
 * One row list for every kind of document the viewer shows.
 *
 * A file, a patch, and a patch laid back into its file are the same surface
 * on a phone; only the provenance of the rows differs. Building that list here
 * keeps the prototype switch in `DocumentViewer` to a single branch.
 */

import { inlay, parseHunks, type InlayRow } from '@/components/diff/inlay';

export interface SurfaceSeparator {
    /** Row index this separator sits before. */
    row: number;
    /** Lines of the file the patch skipped over. */
    lines: number;
}

export interface SurfaceModel {
    rows: InlayRow[];
    hunkRows: number[];
    /** Only an inlaid document has untouched runs worth folding. */
    foldUnchanged: boolean;
    /** True when the patch could be laid back into the file content. */
    inlaid: boolean;
    /**
     * Gaps the patch jumped over. Without file content there is nothing to
     * expand into, so these render as a plain rule rather than a control — but
     * without them two hunks a line apart read as one continuous block.
     */
    separators: SurfaceSeparator[];
}

/** Hunk rows only, for a patch whose file content we do not have. */
function patchOnly(patch: string): SurfaceModel {
    const rows: InlayRow[] = [];
    const hunkRows: number[] = [];
    const separators: SurfaceSeparator[] = [];
    const hunks = parseHunks(patch);
    hunks.forEach((hunk, index) => {
        const previous = hunks[index - 1];
        const gap = previous === undefined
            ? hunk.newStart - 1
            : hunk.newStart - (previous.newStart + previous.newCount);
        if (gap > 0) separators.push({ row: rows.length, lines: gap });
        hunkRows.push(rows.length);
        let oldLine = hunk.oldStart;
        let newLine = hunk.newStart;
        for (const raw of hunk.lines) {
            const text = raw.slice(1);
            if (raw.charAt(0) === '-') {
                rows.push({ prefix: '-', text, oldLine, hunk: index });
                oldLine += 1;
            } else if (raw.charAt(0) === '+') {
                rows.push({ prefix: '+', text, newLine, hunk: index });
                newLine += 1;
            } else {
                rows.push({ prefix: ' ', text, oldLine, newLine, hunk: index });
                oldLine += 1;
                newLine += 1;
            }
        }
    });
    return { rows, hunkRows, foldUnchanged: false, inlaid: false, separators };
}

export function surfaceModel(options: { code?: string; diff?: string; showChanges: boolean }): SurfaceModel | null {
    const { code, diff, showChanges } = options;
    if (showChanges && diff !== undefined && diff !== '') {
        if (code !== undefined && code !== '') {
            const laid = inlay(code, diff);
            // A patch that does not match the content we hold is not shown as
            // if it did; the hunk-only rows are honest about what is known.
            if (laid !== null) {
                return { rows: laid.rows, hunkRows: laid.hunkRows, foldUnchanged: true, inlaid: true, separators: [] };
            }
        }
        return patchOnly(diff);
    }
    if (code === undefined || code === '') return null;
    return {
        rows: code.split('\n').map((text, index) => ({ prefix: ' ' as const, text, newLine: index + 1, hunk: -1 })),
        hunkRows: [],
        foldUnchanged: false,
        inlaid: false,
        separators: [],
    };
}
