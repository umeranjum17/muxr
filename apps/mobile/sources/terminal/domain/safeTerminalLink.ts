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
