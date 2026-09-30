/**
 * The only schemes a terminal link may OPEN. Terminal output is untrusted:
 * executable, file, javascript, data and unknown schemes are copyable text
 * at most, never handed to a handler. See openTerminalLink.
 */
const SAFE_TERMINAL_LINK_SCHEMES = new Set(['http:', 'https:']);

/** The absolute http(s) URL, or null when the string is not safe to open. */
export function safeTerminalLinkUrl(raw: string): string | null {
    const trimmed = raw.trim();
    if (trimmed.length === 0 || trimmed.length > 2048) return null;
    let url: URL;
    try {
        url = new URL(trimmed);
    } catch {
        return null;
    }
    if (!SAFE_TERMINAL_LINK_SCHEMES.has(url.protocol)) return null;
    if (url.hostname.length === 0) return null;
    return url.toString();
}

/**
 * Open a link the terminal printed, through the app's browser boundary.
 * Everything that is not a safe web URL is dropped: tapping terminal output
 * must never reach a scheme handler.
 */
export function openTerminalLink(raw: string, open: (url: string) => Promise<void>): void {
    const safe = safeTerminalLinkUrl(raw);
    if (safe === null) return;
    void open(safe);
}

/**
 * Plain http(s) URLs as printed in terminal text. Source-identical to the
 * PWA web-links addon's default regex, so the underline, the tap target, and
 * the long-press copy all agree on where a link starts and ends (trailing
 * punctuation never joins the link).
 */
export const TERMINAL_URL_PATTERN =
    /(https?|HTTPS?):[/]{2}[^\s"'!*(){}|\\\^<>`]*[^\s"':,.!?{}|\\\^~\[\]`()<>]/g;

/**
 * The exact link text at a character index of joined terminal text (wrapped
 * rows joined into one string), or null when the index is not inside a plain
 * URL. This is the string a long-press copy puts on the clipboard.
 */
export function terminalUrlAt(text: string, at: number): string | null {
    if (at < 0 || at > text.length) return null;
    const pattern = new RegExp(TERMINAL_URL_PATTERN.source, 'g');
    for (let match = pattern.exec(text); match !== null; match = pattern.exec(text)) {
        if (at >= match.index && at < match.index + match[0].length) return match[0];
        if (match.index > at) break;
    }
    return null;
}

/** One terminal row as the long-press join rule sees it: printable text with
 *  trailing whitespace trimmed, and whether the row continues the row above
 *  (soft wrap). A hard new line is isWrapped: false. */
export interface TerminalLinkRow {
    text: string;
    isWrapped: boolean;
}

/**
 * The rows a wrapped join resolves across: rowIndex's soft-wrapped run —
 * upward while the run continues, stopping after the first row containing a
 * space, mirrored downward — plus rowIndex's string offset inside the join.
 * Every row of one run sees the same span, so hit-testing and decorations
 * agree on where a printed link starts and ends.
 */
function joinedTerminalWindow(
    rowAt: (row: number) => TerminalLinkRow | undefined,
    rowIndex: number,
): { lines: string[]; offset: number } {
    const textOf = (row: number): string => rowAt(row)?.text ?? '';
    const lines: string[] = [textOf(rowIndex)];
    let top = rowIndex;
    for (;;) {
        if (top <= 0 || !rowAt(top)?.isWrapped) break;
        const t = textOf(top - 1);
        lines.unshift(t);
        top--;
        if (t.includes(' ')) break;
    }
    let bottom = rowIndex;
    for (;;) {
        if (!rowAt(bottom + 1)?.isWrapped) break;
        const t = textOf(bottom + 1);
        lines.push(t);
        bottom++;
        if (t.includes(' ')) break;
    }
    let offset = 0;
    for (let i = 0; i < rowIndex - top; i++) offset += lines[i].length;
    return { lines, offset };
}

/**
 * The exact link text under (rowIndex, at) of terminal rows, joined across
 * soft-wrapped rows only. A hard new line never inherits the row above: a
 * full-width URL followed by a hard new line stops at that line. `at` is a
 * string index inside row rowIndex's text.
 */
export function joinedTerminalUrlAt(
    rowAt: (row: number) => TerminalLinkRow | undefined,
    rowIndex: number,
    at: number,
): string | null {
    const span = joinedTerminalWindow(rowAt, rowIndex);
    return terminalUrlAt(span.lines.join(''), span.offset + at);
}

/**
 * The cell ranges to underline on one row of terminal text: the plain http(s)
 * URLs the wrapped-row join resolves there, mapped back through the row's
 * cell map. A soft-wrapped URL underlines its share of every row it spans,
 * so the affordance is continuous exactly where tap-open and long-press
 * copy resolve the same link.
 */
export function joinedTerminalUrlRanges(
    line: TerminalLineCells,
    cols: number,
    row: number,
    rowAt: (r: number) => TerminalLinkRow | undefined,
): { start: number; length: number }[] {
    const { text, cellOf } = lineCellMap(line, cols);
    const span = joinedTerminalWindow(rowAt, row);
    const joined = span.lines.join('');
    const from = span.offset;
    const to = from + text.length;
    const ranges: { start: number; length: number }[] = [];
    const pattern = new RegExp(TERMINAL_URL_PATTERN.source, 'g');
    for (let match = pattern.exec(joined); match !== null; match = pattern.exec(joined)) {
        if (match.index >= to) break;
        const start = Math.max(match.index, from);
        const end = Math.min(match.index + match[0].length, to);
        if (end <= start) continue;
        const startCell = cellOf[start - from];
        const endCell = cellOf[end - 1 - from];
        if (startCell !== undefined && endCell !== undefined) {
            ranges.push({ start: startCell, length: endCell - startCell + 1 });
        }
    }
    return ranges;
}

/** One cell of an xterm buffer line, as the cell map walks it. */
interface TerminalLineCell {
    getChars(): string;
    getWidth(): number;
}

/** The subset of an xterm buffer line the cell map walks. */
interface TerminalLineCells {
    getCell(col: number, scratch?: TerminalLineCell): TerminalLineCell | undefined;
}

/**
 * One buffer line as text plus, per UTF-16 unit, the cell it came from: cells
 * and string units diverge on wide glyphs, so hit-testing maps between them.
 * Matches IBufferLine.translateToString(false) cell for cell, including its
 * skip of the zero-width cell that follows each wide glyph.
 */
export function lineCellMap(line: TerminalLineCells, cols: number): { text: string; cellOf: number[] } {
    let text = '';
    const cellOf: number[] = [];
    const scratch = line.getCell(0);
    for (let c = 0; c < cols; c++) {
        const filled = line.getCell(c, scratch);
        if (!filled) break;
        if (filled.getWidth() === 0) continue;
        const ch = filled.getChars() || ' ';
        text += ch;
        for (let k = 0; k < ch.length; k++) cellOf.push(c);
    }
    return { text, cellOf };
}

/**
 * The plain link under a tapped cell of one buffer line, joined across
 * wrapped rows through rowAt. A cell outside the line's text (trailing
 * whitespace, a wide glyph's spacer half) is not a link.
 */
export function plainLinkAtCell(
    line: TerminalLineCells,
    cols: number,
    col: number,
    row: number,
    rowAt: (r: number) => TerminalLinkRow | undefined,
): string | null {
    const at = lineCellMap(line, cols).cellOf.indexOf(col);
    if (at < 0 || at >= (rowAt(row)?.text.length ?? 0)) return null;
    return joinedTerminalUrlAt(rowAt, row, at);
}

/** One printed path character, as Ghostty's link regex spells it. */
const PATH_CHAR = String.raw`[\w\-.~:\/?#@!$&*+;=%]`;

/**
 * Printed host paths in one terminal row: the path half of Ghostty's link
 * regex (libghostty's url.zig), which is what native iOS detects on its own.
 * GhosttyTerminalView.kt (Android, in patches/expo-libghostty+0.8.1.patch)
 * carries the same source so every client taps the same paths;
 * verifyNativePatches.mjs fails when the two differ. Its one change is a
 * bounded `$VAR` look-behind, which Android's ICU regex requires. Like
 * Ghostty it may keep the words after a path on the line;
 * terminalPathCandidates drops them again.
 */
const TERMINAL_PATH_SOURCE = String.raw`(?:\.\.\/|\.\/|(?<!\w)~\/|(?:[\w][\w\-.]*\/)*(?<!\w)\$[A-Za-z_]\w*\/|\.[\w][\w\-.]*\/|(?<![\w~\/])\/(?!\/))(?:(?=${PATH_CHAR}*\.)${PATH_CHAR}+(?:(?<!:) (?!\w+:\/\/)(?!\.{0,2}\/)(?!~\/)${PATH_CHAR}*[\/.])*(?<!:)(?: +(?= *$))?|(?!${PATH_CHAR}*\.)${PATH_CHAR}+(?:(?<!:) (?!\w+:\/\/)(?!\.{0,2}\/)(?!~\/)${PATH_CHAR}+)*(?<!:)(?: +(?= *$))?)|(?=${PATH_CHAR}*\.)(?<!\$\d{0,9})(?<!\w)[\w][\w\-.]*\/${PATH_CHAR}+(?<!:)(?: +(?= *$))?`;

/** [start, end) string ranges of the host paths printed in one row. A URL's
 *  own path belongs to the URL, so URLs are blanked out first. */
export function terminalPathRanges(text: string): { start: number; end: number }[] {
    const masked = text.replace(/[A-Za-z][\w+.-]*:\/\/\S*/g, (url) => ' '.repeat(url.length));
    const ranges: { start: number; end: number }[] = [];
    const pattern = new RegExp(TERMINAL_PATH_SOURCE, 'g');
    for (let match = pattern.exec(masked); match !== null; match = pattern.exec(masked)) {
        const end = match.index + match[0].trimEnd().length;
        if (end > match.index) ranges.push({ start: match.index, end });
        if (match[0].length === 0) pattern.lastIndex++;
    }
    return ranges;
}

/** Whether a tapped link names a host path (a printed path or a file: URL)
 *  rather than a web address. */
export function isTerminalPath(raw: string): boolean {
    const text = raw.trim();
    if (text.length === 0 || text.length > 2048) return false;
    if (/^file:/i.test(text)) return true;
    return !/^[A-Za-z][\w+.-]*:/.test(text) && text.includes('/');
}

/**
 * The paths a tapped string may name, longest first. A file: URL is decoded
 * and a `:line[:col]` suffix dropped. Ghostty keeps the words that follow a
 * path on its line (`~/notes.md is ready`), while a folder name may itself
 * hold a space, so each trailing word is dropped in turn and the host decides
 * which candidate exists.
 */
export function terminalPathCandidates(raw: string): string[] {
    let text = raw.trim();
    if (/^file:/i.test(text)) {
        text = text.replace(/^file:(?:\/\/[^/]*)?/i, '');
        try {
            text = decodeURIComponent(text);
        } catch {
            // Keep the undecoded path.
        }
    }
    const words = text.split(' ');
    const candidates: string[] = [];
    for (let count = words.length; count > 0 && candidates.length < 6; count--) {
        const candidate = words.slice(0, count).join(' ')
            .replace(/(?::\d+){1,2}:?$/, '')
            .replace(/[.,;:!?'"`)\]}>]+$/, '')
            .trimEnd();
        if (candidate !== '' && !candidates.includes(candidate)) candidates.push(candidate);
    }
    return candidates;
}
