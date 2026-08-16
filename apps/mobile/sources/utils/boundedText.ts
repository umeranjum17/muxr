export interface BoundedText {
    text: string;
    totalLines: number;
    omittedLines: number;
    omittedChars: number;
}

/** Keep bounded source text without split() allocating every line. */
export function boundText(source: string, maxLines = 2000, maxChars = 256 * 1024): BoundedText {
    if (source.length === 0) return { text: '', totalLines: 0, omittedLines: 0, omittedChars: 0 };
    // A terminal newline terminates the last real line; downstream split('\n')
    // must not turn it into a phantom extra render node.
    const sourceLength = source.endsWith('\n') ? source.length - 1 : source.length;
    if (sourceLength === 0) return { text: '', totalLines: 1, omittedLines: 0, omittedChars: 0 };
    let totalLines = 1;
    for (let i = 0; i < sourceLength; i += 1) if (source.charCodeAt(i) === 10) totalLines += 1;
    let cursor = 0;
    let lines = 0;
    while (cursor < sourceLength && lines < maxLines && cursor < maxChars) {
        const newline = source.indexOf('\n', cursor);
        const lineEnd = newline < 0 || newline >= sourceLength ? sourceLength : newline + 1;
        const next = Math.min(lineEnd, maxChars);
        if (next <= cursor) break;
        cursor = next;
        lines += 1;
        if (next < lineEnd) break;
    }
    if (lines === maxLines && cursor > 0 && source.charCodeAt(cursor - 1) === 10) cursor -= 1;
    const omittedChars = sourceLength - cursor;
    const omittedLines = Math.max(0, totalLines - lines);
    return { text: source.slice(0, cursor), totalLines, omittedLines, omittedChars };
}
