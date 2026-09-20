/**
 * The terminal key row's vocabulary: the built-in catalog a phone can want,
 * the default row (the first thing a new owner sees), and the resolution rule
 * that turns a stored arrangement back into keys. The device's own row wins;
 * absent, the built-in default stands.
 */

/** The stored row's entry cap; the key-row editor enforces it where keys are added. */
export const TERMINAL_KEY_ROW_LIMIT = 32;

export type TerminalKeyAction = 'paste' | 'hide-keyboard';

export interface TerminalKey {
    label: string;
    accessibilityLabel: string;
    send: string;
    /** Only for keys whose shifted form is not derivable, like tab's backtab. */
    shift?: string;
    repeat?: boolean;
    /**
     * Rail actions are not byte keys: paste and hide-keyboard do a thing to
     * the composer or the keyboard and must never be encoded through
     * modifiedSend, which exists to send exact terminal bytes.
     */
    action?: TerminalKeyAction;
}

/** A custom key as the editor stores it on this device. */
export interface CustomKey {
    label: string;
    send: string;
    repeat?: boolean;
}

/** One entry of a stored row: a catalog id or an inline custom key. */
export type RowEntry = string | CustomKey;

const fKeys: Record<string, TerminalKey> = Object.fromEntries(
    [
        ['f1', '\u001bOP'], ['f2', '\u001bOQ'], ['f3', '\u001bOR'], ['f4', '\u001bOS'],
        ['f5', '\u001b[15~'], ['f6', '\u001b[17~'], ['f7', '\u001b[18~'], ['f8', '\u001b[19~'],
        ['f9', '\u001b[20~'], ['f10', '\u001b[21~'], ['f11', '\u001b[23~'], ['f12', '\u001b[24~'],
    ].map(([id, send]) => [id, { label: id.toUpperCase(), accessibilityLabel: `Function key ${id.slice(1)}`, send }]),
);

export const BUILTIN_KEY_CATALOG: Record<string, TerminalKey> = {
    esc: { label: 'esc', accessibilityLabel: 'Escape', send: '\u001b' },
    tab: { label: 'tab', accessibilityLabel: 'Tab', send: '\t', shift: '\u001b[Z' },
    'ctrl-c': { label: '^C', accessibilityLabel: 'Control C', send: '\u0003' },
    'ctrl-d': { label: '^D', accessibilityLabel: 'Control D', send: '\u0004' },
    'ctrl-l': { label: '^L', accessibilityLabel: 'Control L', send: '\u000c' },
    'ctrl-r': { label: '^R', accessibilityLabel: 'Control R', send: '\u0012' },
    'ctrl-u': { label: '^U', accessibilityLabel: 'Control U', send: '\u0015' },
    'ctrl-w': { label: '^W', accessibilityLabel: 'Control W', send: '\u0017' },
    'ctrl-z': { label: '^Z', accessibilityLabel: 'Control Z', send: '\u001a' },
    enter: { label: '\u23ce', accessibilityLabel: 'Enter', send: '\r' },
    left: { label: '\u2190', accessibilityLabel: 'Left arrow', send: '\u001b[D', repeat: true },
    up: { label: '\u2191', accessibilityLabel: 'Up arrow', send: '\u001b[A', repeat: true },
    down: { label: '\u2193', accessibilityLabel: 'Down arrow', send: '\u001b[B', repeat: true },
    right: { label: '\u2192', accessibilityLabel: 'Right arrow', send: '\u001b[C', repeat: true },
    home: { label: 'home', accessibilityLabel: 'Home', send: '\u001b[H' },
    end: { label: 'end', accessibilityLabel: 'End', send: '\u001b[F' },
    pgup: { label: 'pgup', accessibilityLabel: 'Page up', send: '\u001b[5~', repeat: true },
    pgdn: { label: 'pgdn', accessibilityLabel: 'Page down', send: '\u001b[6~', repeat: true },
    backslash: { label: '\\', accessibilityLabel: 'Backslash', send: '\\' },
    pipe: { label: '|', accessibilityLabel: 'Pipe', send: '|' },
    tilde: { label: '~', accessibilityLabel: 'Tilde', send: '~' },
    caret: { label: '^', accessibilityLabel: 'Caret', send: '^' },
    backtick: { label: '`', accessibilityLabel: 'Backtick', send: '`' },
    paste: { label: 'paste', accessibilityLabel: 'Paste into prompt', send: '', action: 'paste' },
    'hide-keyboard': { label: 'hide kb', accessibilityLabel: 'Hide keyboard', send: '', action: 'hide-keyboard' },
    ...fKeys,
};

export const DEFAULT_ROW_IDS: readonly string[] = ['esc', 'tab', 'ctrl-c', 'ctrl-d', 'enter', 'left', 'up', 'down', 'right', 'paste', 'hide-keyboard'];

/** Groups for the add-key grid, in the order a person scans them. */
export const CATALOG_GROUPS: readonly { title: string; ids: readonly string[] }[] = [
    { title: 'Editing', ids: ['esc', 'tab', 'enter', 'ctrl-c', 'ctrl-d', 'ctrl-l', 'ctrl-r', 'ctrl-u', 'ctrl-w', 'ctrl-z'] },
    { title: 'Navigation', ids: ['left', 'up', 'down', 'right', 'home', 'end', 'pgup', 'pgdn'] },
    { title: 'Shell', ids: ['backslash', 'pipe', 'tilde', 'caret', 'backtick'] },
    { title: 'Function keys', ids: Object.keys(fKeys) },
    { title: 'Actions', ids: ['paste', 'hide-keyboard'] },
];

/**
 * The row a person actually sees: their own arrangement when they have made
 * one (ids resolve through the catalog, unknown ids are skipped), else the
 * built-in default.
 */
export function resolveKeyRow(entries: readonly RowEntry[] | null | undefined): TerminalKey[] {
    if (entries === null || entries === undefined) return DEFAULT_ROW_IDS.map((id) => BUILTIN_KEY_CATALOG[id]);
    return entries
        .map((entry) => typeof entry === 'string'
            ? BUILTIN_KEY_CATALOG[entry]
            : { label: entry.label, accessibilityLabel: entry.label, send: entry.send, ...(entry.repeat === true ? { repeat: true } : {}) })
        .filter((key): key is TerminalKey => key !== undefined);
}

/**
 * What a key sends with modifiers armed, or null when the modifier has no
 * encoding for it - a terminal cannot express ctrl+enter or shift+^C, and a
 * key that silently sent its unmodified bytes would lie about the chord.
 * Parameterised keys (CSI and SS3) take the xterm modifier parameter, ctrl
 * plus a letter folds to its control byte.
 */
export function modifiedSend(key: TerminalKey, ctrl: boolean, shift: boolean): string | null {
    if (!ctrl && !shift) return key.send;
    if (shift && !ctrl && key.shift !== undefined) return key.shift;
    const param = 1 + Number(shift) + 4 * Number(ctrl);
    const ss3 = /^\u001bO([A-Z])$/.exec(key.send);
    if (ss3 !== null) return `\u001b[1;${param}${ss3[1]}`;
    const csi = /^\u001b\[([0-9]*)([A-Z~])$/.exec(key.send);
    if (csi !== null) return `\u001b[${csi[1] === '' ? '1' : csi[1]};${param}${csi[2]}`;
    if (ctrl && !shift && key.send.length === 1) {
        const code = key.send.charCodeAt(0);
        if ((code >= 0x40 && code <= 0x5f) || (code >= 0x61 && code <= 0x7a)) return String.fromCharCode(code & 0x1f);
    }
    return null;
}

/**
 * Escape syntax for a custom key's bytes: `\e` escape, `\n` newline, `\r`
 * carriage return, `\t` tab, `\xHH` a byte from `\x00` to `\x7f`, `\\` literal
 * backslash. Null on an incomplete escape, or on a byte above `\x7f` that the
 * text transport would deliver as two UTF-8 bytes, so a typo never sends a
 * wrong key.
 */
export function escapeToBytes(text: string): string | null {
    if (text === '') return null;
    let out = '';
    for (let i = 0; i < text.length; i += 1) {
        const ch = text[i];
        if (ch !== '\\') {
            out += ch;
            continue;
        }
        const next = text[i + 1];
        if (next === 'e') out += '\u001b';
        else if (next === 'n') out += '\n';
        else if (next === 'r') out += '\r';
        else if (next === 't') out += '\t';
        else if (next === 'x') {
            const hex = text.slice(i + 2, i + 4);
            if (!/^[0-7][0-9a-fA-F]$/.test(hex)) return null;
            out += String.fromCharCode(parseInt(hex, 16));
            i += 2;
        } else if (next === '\\') out += '\\';
        else return null;
        i += 1;
    }
    return out === '' ? null : out;
}

/** The reverse of escapeToBytes, so the editor can show what a key sends. */
export function bytesToEscape(bytes: string): string {
    let out = '';
    for (const ch of bytes) {
        const code = ch.codePointAt(0) ?? 0;
        if (ch === '\\') out += '\\\\';
        else if (ch === '\u001b') out += '\\e';
        else if (ch === '\n') out += '\\n';
        else if (ch === '\r') out += '\\r';
        else if (ch === '\t') out += '\\t';
        else if (code < 0x20 || code === 0x7f) out += `\\x${code.toString(16).padStart(2, '0')}`;
        else out += ch;
    }
    return out;
}
