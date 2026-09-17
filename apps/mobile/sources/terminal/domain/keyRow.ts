import { decodeKeyBytes } from '@muxr/contract';

/**
 * The terminal key row's vocabulary: the built-in catalog a phone can want,
 * the default row (the first thing a new owner sees), and the resolution rule
 * that makes the phone editor and the host's operator config two views of one
 * row. Precedence: per-device customisation > operator row > built-in default.
 */

export interface TerminalKey {
    label: string;
    accessibilityLabel: string;
    send: string;
    ctrl?: string;
    shift?: string;
    ctrlShift?: string;
    repeat?: boolean;
}

/** A custom key as the editor stores it on this device. */
export interface CustomKey {
    label: string;
    accessibilityLabel?: string;
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
    left: { label: '\u2190', accessibilityLabel: 'Left arrow', send: '\u001b[D', ctrl: '\u001b[1;5D', shift: '\u001b[1;2D', ctrlShift: '\u001b[1;6D', repeat: true },
    up: { label: '\u2191', accessibilityLabel: 'Up arrow', send: '\u001b[A', ctrl: '\u001b[1;5A', shift: '\u001b[1;2A', ctrlShift: '\u001b[1;6A', repeat: true },
    down: { label: '\u2193', accessibilityLabel: 'Down arrow', send: '\u001b[B', ctrl: '\u001b[1;5B', shift: '\u001b[1;2B', ctrlShift: '\u001b[1;6B', repeat: true },
    right: { label: '\u2192', accessibilityLabel: 'Right arrow', send: '\u001b[C', ctrl: '\u001b[1;5C', shift: '\u001b[1;2C', ctrlShift: '\u001b[1;6C', repeat: true },
    home: { label: 'home', accessibilityLabel: 'Home', send: '\u001b[H' },
    end: { label: 'end', accessibilityLabel: 'End', send: '\u001b[F' },
    pgup: { label: 'pgup', accessibilityLabel: 'Page up', send: '\u001b[5~', repeat: true },
    pgdn: { label: 'pgdn', accessibilityLabel: 'Page down', send: '\u001b[6~', repeat: true },
    backslash: { label: '\\', accessibilityLabel: 'Backslash', send: '\\' },
    pipe: { label: '|', accessibilityLabel: 'Pipe', send: '|' },
    tilde: { label: '~', accessibilityLabel: 'Tilde', send: '~' },
    caret: { label: '^', accessibilityLabel: 'Caret', send: '^' },
    backtick: { label: '`', accessibilityLabel: 'Backtick', send: '`' },
    ...fKeys,
};

export const DEFAULT_ROW_IDS: readonly string[] = ['esc', 'tab', 'ctrl-c', 'ctrl-d', 'enter', 'left', 'up', 'down', 'right'];

/** Groups for the add-key grid, in the order a person scans them. */
export const CATALOG_GROUPS: readonly { title: string; ids: readonly string[] }[] = [
    { title: 'Editing', ids: ['esc', 'tab', 'enter', 'ctrl-c', 'ctrl-d', 'ctrl-l', 'ctrl-r', 'ctrl-u', 'ctrl-w', 'ctrl-z'] },
    { title: 'Navigation', ids: ['left', 'up', 'down', 'right', 'home', 'end', 'pgup', 'pgdn'] },
    { title: 'Shell', ids: ['backslash', 'pipe', 'tilde', 'caret', 'backtick'] },
    { title: 'Function keys', ids: Object.keys(fKeys) },
];

/**
 * The row a person actually sees: their own arrangement when they have made
 * one (ids resolve through the catalog, unknown ids are skipped), else the
 * operator's declared row from the host config, else the built-in default.
 */
export function resolveKeyRow(entries: readonly RowEntry[] | null | undefined, operatorKeys: readonly TerminalKeyDefinitionLike[] | undefined): TerminalKey[] {
    if (entries !== null && entries !== undefined) {
        return entries
            .map((entry) => typeof entry === 'string'
                ? BUILTIN_KEY_CATALOG[entry]
                : { label: entry.label, accessibilityLabel: entry.accessibilityLabel ?? entry.label, send: entry.send, ...(entry.repeat === true ? { repeat: true } : {}) })
            .filter((key): key is TerminalKey => key !== undefined);
    }
    if (operatorKeys !== undefined && operatorKeys.length > 0) {
        return operatorKeys.map((key) => ({
            label: key.label,
            accessibilityLabel: key.accessibilityLabel ?? key.label,
            send: key.send,
            ...(key.repeat === true ? { repeat: true } : {}),
        }));
    }
    return DEFAULT_ROW_IDS.map((id) => BUILTIN_KEY_CATALOG[id]);
}

type TerminalKeyDefinitionLike = { label: string; accessibilityLabel?: string; send: string; repeat?: boolean };

/**
 * Escape syntax for a custom key's bytes - the same syntax the operator config
 * file speaks, so a sequence copied between the file and the editor behaves
 * the same: `\e` escape, `\n` newline, `\t` tab, `\xHH` any byte, `\\` literal
 * backslash. Null on an incomplete escape so a typo never sends a wrong key.
 */
export function escapeToBytes(text: string): string | null {
    if (text === '') return null;
    const bytes = decodeKeyBytes(text);
    return bytes === null || bytes === '' ? null : bytes;
}
