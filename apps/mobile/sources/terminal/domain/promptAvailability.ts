import type { HerdrTreePane } from '@trymuxr/contract';

export interface PendingChoice {
    /** What to type: the choice's own number, or the arrow presses that reach it and Enter. */
    key: string;
    label: string;
    /** The number the agent shows beside the choice, when it numbers them. */
    number?: string;
}

const CHOICE_LINE = /^\s*(?:[❯›]\s*)?(\d)\.\s+(\S.*?)\s*$/;
/** The highlighted row of a menu with no numbers: Claude Code's folder-trust "❯ No, exit". */
const CURSOR_LINE = /^(\s*)[❯›]\s+(\S.*?)\s*$/;
const DOWN = '\u001b[B';
const UP = '\u001b[A';
const RIGHT = '\u001b[C';
const LEFT = '\u001b[D';
/** An escape sequence: SGR and any other CSI, an OSC, or a two-byte escape such as a charset (ESC ( B). */
const ESCAPE = /(\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[ -/]*[0-~])/;
/**
 * OpenCode's permission dialog, " Allow once   Allow always   Reject " in one
 * row with the selected button drawn on its own background. Its Allow always
 * opens a Confirm step (Confirm selected) that Herdr does not report as
 * blocked, so that answer presses Enter once more to confirm it.
 */
const OPENCODE_PERMISSION = [
    { label: 'Allow once', confirm: '' },
    { label: 'Allow always', confirm: '\r' },
    { label: 'Reject', confirm: '' },
];
/** Screen lines at the bottom that may hold the row: its footer can wrap at phone width. */
const BUTTON_ROW_LINES = 10;
/** How many arguments follow 38/48: 2 picks 24-bit r;g;b, 5 picks a palette index. */
const COLOUR_ARGS: Record<string, number> = { '2': 4, '5': 2 };
/** Lines a question may show under its last choice: "Esc to cancel", "Press enter to continue". */
const FOOTER_LINES = 6;
/** Lines a long choice may wrap onto at phone width before the next one. */
const WRAP_LINES = 4;

/**
 * The choices an agent is waiting on at the live edge of its screen.
 * Numbered ones, Claude Code's "❯ 1. Yes / 2. … / 4. No" and Codex's
 * "› 1. Yes, continue", answer to their number, which selects and confirms.
 * Only a run numbered 1..n at the bottom of the screen counts; a numbered list
 * higher up is the agent talking, not asking. A menu with no numbers, such as
 * Claude Code's folder-trust question, answers to arrow presses from its
 * highlighted row and Enter. OpenCode's permission buttons sit in one row
 * and answer to Left/Right presses from the selected one and Enter.
 *
 * The screen is Herdr's ANSI read: the selected OpenCode button shows only
 * in its background colour.
 */
export function pendingChoices(screen: string, columns?: number): PendingChoice[] {
    const text = screen.split(ESCAPE).filter((part) => !part.startsWith('\x1b')).join('');
    const numbered = numberedChoices(text);
    if (numbered.length > 0) return numbered;
    const permission = opencodePermissionChoices(screen);
    return permission.length > 0 ? permission : unnumberedChoices(text, columns);
}

/**
 * OpenCode's permission buttons, found by their labels in one row near the
 * bottom. At phone width the row is cut off at the grid edge ("Allow alway"),
 * so a visible button need only start its label, and the chips carry
 * OpenCode's full labels. The selected button is the one whose background
 * differs from the row's; when none visible does, it is the one button cut off
 * entirely. With fewer than two buttons in view, or more than one cut off,
 * there is no honest answer.
 */
function opencodePermissionChoices(screen: string): PendingChoice[] {
    const lines = screen.split('\n');
    for (let index = lines.length - 1; index >= Math.max(0, lines.length - BUTTON_ROW_LINES); index--) {
        const { text, backgrounds } = cells(lines[index]!);
        const words = [...text.matchAll(/\S+(?: \S+)*/g)];
        const first = words.findIndex((word) => word[0] === OPENCODE_PERMISSION[0]!.label);
        if (first === -1) continue;
        const visible = words.slice(first, first + OPENCODE_PERMISSION.length);
        if (visible.length < 2 || visible.some((word, button) => !OPENCODE_PERMISSION[button]!.label.startsWith(word[0]))) return [];
        const start = visible[0]!.index;
        if (start < 2) return [];
        // The cell before the first button's padding is the row's own background;
        // a row with none was read without colour, which hides the selection.
        const row = backgrounds[start - 2];
        if (row === undefined || row === '') return [];
        const lit = visible.flatMap((word, button) => (backgrounds[word.index] === row ? [] : [button]));
        const hidden = OPENCODE_PERMISSION.length - visible.length;
        let selected = lit.length === 1 ? lit[0]! : -1;
        if (lit.length === 0 && hidden === 1) selected = OPENCODE_PERMISSION.length - 1;
        if (selected === -1) return [];
        return OPENCODE_PERMISSION.map(({ label, confirm }, button) => {
            const moves = button > selected ? RIGHT.repeat(button - selected) : LEFT.repeat(selected - button);
            return { key: `${moves}\r${confirm}`, label };
        });
    }
    return [];
}

/** A line's text with the background SGR each of its characters is drawn on. */
function cells(line: string): { text: string; backgrounds: string[] } {
    let text = '';
    const backgrounds: string[] = [];
    let background = '';
    for (const part of line.split(ESCAPE)) {
        if (part.startsWith('\x1b')) {
            if (part.startsWith('\x1b[') && part.endsWith('m')) background = nextBackground(background, part.slice(2, -1));
            continue;
        }
        text += part;
        for (let unit = 0; unit < part.length; unit++) backgrounds.push(background);
    }
    return { text, backgrounds };
}

function nextBackground(background: string, params: string): string {
    const codes = params === '' ? ['0'] : params.split(';');
    let next = background;
    for (let at = 0; at < codes.length; at++) {
        const code = codes[at]!;
        if (code === '38' || code === '48') {
            const span = COLOUR_ARGS[codes[at + 1] ?? ''] ?? 0;
            if (code === '48') next = codes.slice(at, at + span + 1).join(';');
            at += span;
        } else if (code === '0' || code === '49') {
            next = '';
        } else if (/^(?:4[0-7]|10[0-7])$/.test(code)) {
            next = code;
        }
    }
    return next;
}

function numberedChoices(screen: string): PendingChoice[] {
    const lines = screen.split('\n').filter((line) => line.trim() !== '');
    const found: PendingChoice[] = [];
    let gap: string[] = [];
    for (let index = lines.length - 1; index >= 0; index--) {
        const line = lines[index]!;
        const match = CHOICE_LINE.exec(line);
        const expected = found.length === 0 ? undefined : String(Number(found[0]!.key) - 1);
        if (match !== null) {
            if (expected !== undefined && match[1] !== expected) return [];
            const indent = line.length - line.trimStart().length;
            if (gap.some((wrapped) => /^\s*(?:\S+\s+)?\d[.)]\s+/.test(wrapped))) return [];
            const wrapLines = gap.reverse();
            const footer = wrapLines.findIndex((wrapped) => wrapped.length - wrapped.trimStart().length <= indent);
            if (found.length > 0 && footer !== -1) return [];
            const continuation = found.length === 0 && footer !== -1 ? wrapLines.slice(0, footer) : wrapLines;
            if (continuation.length > WRAP_LINES || wrapLines.length - continuation.length > FOOTER_LINES) return [];
            found.unshift({ key: match[1]!, number: match[1]!, label: [match[2]!, ...continuation.map((wrapped) => wrapped.trim())].join(' ') });
            if (match[1] === '1') break;
            gap = [];
            continue;
        }
        gap.push(line);
        if (gap.length > (found.length === 0 ? FOOTER_LINES + WRAP_LINES : WRAP_LINES)) return [];
    }
    return found.length >= 2 && found[0]!.key === '1' ? found : [];
}

/**
 * A menu with no numbers: the highlighted row and the rows beside it at the
 * label's own column, with no more than a footer ("Enter to confirm · Esc to
 * cancel") below it. Each answer moves from the highlight to its row and
 * presses Enter, so no answer depends on which row Enter alone would pick.
 * A label wrapped at the pane width reads as two terminal rows, so the rows
 * are rejoined before moves are counted: a visual line continues the logical
 * row above it when that row's visual plus a space plus this line's first
 * word would not fit in the grid width (word wrap). Without the width, or
 * when a visual already exceeds it, there is no honest split, so there are
 * no chips rather than a chip that answers another row.
 */
function unnumberedChoices(screen: string, columns?: number): PendingChoice[] {
    if (columns === undefined || !Number.isFinite(columns) || columns <= 0) return [];
    const lines = screen.split('\n').map((line) => line.trimEnd());
    while (lines.length > 0 && lines.at(-1) === '') lines.pop();
    let cursor = -1;
    for (let index = lines.length - 1; index >= Math.max(0, lines.length - FOOTER_LINES - WRAP_LINES * 2); index--) {
        if (CURSOR_LINE.test(lines[index]!)) { cursor = index; break; }
    }
    if (cursor === -1) return [];
    const [, lead, highlighted] = CURSOR_LINE.exec(lines[cursor]!)!;
    const column = lead!.length + 2;
    const isRow = (line: string | undefined): boolean => line !== undefined && line.trim() !== ''
        && line.length - line.trimStart().length === column && !CURSOR_LINE.test(line);
    let first = cursor;
    while (isRow(lines[first - 1])) first--;
    let last = cursor;
    while (isRow(lines[last + 1])) last++;
    if (last === first || lines.slice(last + 1).filter((line) => line.trim() !== '').length > FOOTER_LINES) return [];
    const visuals = lines.slice(first, last + 1);
    if (visuals.some((visual) => visual.length > columns)) return [];
    const firstWord = (visual: string): string => visual.trim().split(/\s+/)[0] ?? '';
    const rows: string[] = [cursor === first ? highlighted! : visuals[0]!.trim()];
    let cursorRow = 0;
    for (let offset = 1; offset < visuals.length; offset++) {
        const previous = lines[first + offset - 1]!;
        const visual = visuals[offset]!;
        const isCursor = offset + first === cursor;
        const text = isCursor ? CURSOR_LINE.exec(visual)![2]! : visual.trim();
        if (!isCursor) {
            const word = firstWord(visual);
            if (word !== '' && previous.length + 1 + word.length > columns) {
                rows[rows.length - 1] += ` ${text}`;
                continue;
            }
        }
        rows.push(text);
        if (isCursor) cursorRow = rows.length - 1;
    }
    if (rows.length < 2) return [];
    return rows.map((label, row) => {
        const moves = row > cursorRow ? DOWN.repeat(row - cursorRow) : UP.repeat(cursorRow - row);
        return { key: `${moves}\r`, label };
    });
}

/**
 * A pane running an agent accepts a prompt even before it is promptable: the
 * host holds the prompt until the agent can take it. A pane with no agent has
 * nothing to prompt, but a shell takes the draft as a typed line once there is
 * a terminal this device may type into.
 */
export function terminalPaneCanSend(pane: HerdrTreePane | undefined, hasContent: boolean, canType = false): boolean {
    if (pane === undefined || !hasContent) return false;
    return pane.agentKind !== undefined || canType;
}

export function terminalComposerText(draft: string, attachedPaths: string[], isShell: boolean): string {
    const content = isShell && draft.trim() !== '' ? draft : draft.trim();
    return [content, ...attachedPaths].filter((part) => part !== '').join(' ');
}

const STRAIGHT: Record<string, string> = { '‘': '\'', '’': '\'', '“': '"', '”': '"' };

/**
 * Undoes the one edit iOS smart punctuation makes as a shell command is typed:
 * the straight quote just typed swapped for a curly one, or `--` swapped for a
 * dash (iOS inserts the key, then replaces it as a second edit).
 *
 * The composer now disables smart punctuation at the source —
 * `disableSmartPunctuationWithAutocorrection` in AppDelegate.swift makes
 * `autoCorrect={false}` also turn smart quotes and dashes off. This stays as a
 * fallback for the shell pane should that native override stop installing (for
 * example if a React Native upgrade renames its private input classes).
 * Pasted curly text replaces nothing straight, so it is kept.
 */
export function undoSmartPunctuation(previous: string, next: string): string {
    let start = 0;
    while (start < previous.length && start < next.length && previous[start] === next[start]) start++;
    let end = 0;
    while (end < previous.length - start && end < next.length - start
        && previous[previous.length - 1 - end] === next[next.length - 1 - end]) end++;
    const removed = previous.slice(start, previous.length - end);
    const inserted = next.slice(start, next.length - end);
    const quote = STRAIGHT[inserted];
    const straight = quote !== undefined && (removed === '' || removed === quote) ? quote
        : inserted === '—' && removed === '--' ? '--'
            : (inserted === '—' || inserted === '–') && removed === '-' ? '-'
                : undefined;
    return straight === undefined ? next : next.slice(0, start) + straight + next.slice(next.length - end);
}
