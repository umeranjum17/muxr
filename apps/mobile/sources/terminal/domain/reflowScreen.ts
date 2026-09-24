/**
 * A pane's screen, read at the desk's width, set again at the phone's.
 *
 * The desk lays a pane out at whatever width its split gives it; the phone
 * resizes the pane to its own columns when it attaches, and the agent then
 * redraws its transcript at that width. A picture of the screen shown before
 * the attach -- a neighbouring page in the agent pager -- should already look
 * like that redraw, not like the desk's narrower or wider column.
 *
 * The read is plain text with no record of where the agent broke its lines,
 * so the breaks are inferred: a line ended where it did because the next
 * line's first word would not have fitted in the desk's width. That width is
 * only trusted when the screen shows it -- a full-width rule, or several
 * lines that run right up to the same edge. Without it lines are only kept
 * inside the phone's width, never joined.
 */

const RULE = /^[─━═╌┄-]+$/;
const BOX_EDGE = /^([╭┌╰└])[─━]+([╮┐╯┘])$/;
/** A word longer than this at the edge was cut there, not wrapped whole. */
const LONG_WORD = 12;
/** Where a new block starts: a message, a tool result, a list item or a prompt. */
const BLOCK_START = /^(?:[⏺●⎿•*>$›❯✻✓✗✔✘]|-\s|\d+[.)]\s)/;

function indentOf(line: string): number {
    return line.length - line.trimStart().length;
}

function isFrame(line: string): boolean {
    return RULE.test(line) || BOX_EDGE.test(line);
}

/** The desk's width, when the screen itself shows where its edge is. */
function sourceWidth(lines: readonly string[]): number | undefined {
    const widest = Math.max(0, ...lines.map((line) => line.length));
    if (widest === 0) return undefined;
    if (lines.some((line) => line.length === widest && isFrame(line))) return widest;
    return lines.filter((line) => line.length >= widest - 2).length >= 3 ? widest : undefined;
}

function wraps(previous: string, next: string, width: number, indent: number): boolean {
    if (previous.trim() === '' || next.trim() === '' || isFrame(previous) || isFrame(next)) return false;
    const nextIndent = indentOf(next);
    if (nextIndent < indent || nextIndent > indent + 4 || BLOCK_START.test(next.trimStart())) return false;
    const firstWord = next.trimStart().split(' ')[0]!;
    return previous.length + 1 + firstWord.length > width;
}

/**
 * A line that fills the width is ambiguous: a word that ended exactly at the
 * edge, or a long path or URL cut there. Only a long word is taken as cut.
 */
function brokenWord(line: string, width: number): boolean {
    if (line.endsWith('-')) return true;
    return line.length >= width && line.slice(line.lastIndexOf(' ') + 1).length > LONG_WORD;
}

function stretch(line: string, columns: number): string {
    const edge = BOX_EDGE.exec(line);
    if (edge !== null) return edge[1] + line[1]!.repeat(Math.max(0, columns - 2)) + edge[2];
    return line[0]!.repeat(columns);
}

/** Word-wrap one paragraph, the first line as it began and the rest at the hanging indent. */
function wrap(text: string, hanging: number, columns: number): string[] {
    const out: string[] = [];
    const pad = ' '.repeat(Math.min(hanging, Math.max(0, columns - 8)));
    let line = '';
    for (const word of text.split(/(?<=\S)(?= )/)) {
        if (line.length + word.length <= columns || line.trim() === '') {
            line += line === '' && out.length > 0 ? word.trimStart() : word;
        } else {
            out.push(line);
            line = pad + word.trimStart();
        }
        while (line.length > columns) {
            out.push(line.slice(0, columns));
            line = pad + line.slice(columns);
        }
    }
    out.push(line);
    return out;
}

export function reflowScreen(text: string, columns: number): string[] {
    const lines = text.replace(/\s+$/, '').split('\n').map((line) => line.trimEnd());
    if (columns <= 0) return lines;
    const width = sourceWidth(lines);
    const out: string[] = [];
    for (let index = 0; index < lines.length; index++) {
        const first = lines[index]!;
        if (width !== undefined && isFrame(first) && first.length >= width - 1) {
            out.push(stretch(first, columns));
            continue;
        }
        let paragraph = first;
        let hanging = indentOf(first);
        if (width !== undefined) {
            let last = first;
            for (let joined = 0; index + 1 < lines.length && wraps(last, lines[index + 1]!, width, hanging); joined++) {
                const next = lines[++index]!;
                if (joined === 0) hanging = indentOf(next);
                paragraph += (brokenWord(last, width) ? '' : ' ') + next.trimStart();
                last = next;
            }
        }
        out.push(...wrap(paragraph, hanging, columns));
    }
    return out;
}
