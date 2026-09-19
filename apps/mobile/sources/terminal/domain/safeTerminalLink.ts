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
    let anchor = 0;
    for (let i = 0; i < rowIndex - top; i++) anchor += lines[i].length;
    return terminalUrlAt(lines.join(''), anchor + at);
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
