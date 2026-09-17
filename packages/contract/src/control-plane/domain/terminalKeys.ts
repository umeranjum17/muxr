/**
 * Shared terminal key-row vocabulary: one key definition shape and one escape
 * syntax for key bytes, used by the operator config file ($MUXR_HOME/config.json
 * terminalKeys), the phone-side key editor, and the host that serves the file.
 * The phone and the file must agree because they are two editors of one row.
 */

/** One key on the terminal key row. */
export interface TerminalKeyDefinition {
    /** Short mark shown on the key (1-12 characters). */
    label: string;
    /** Absent means the label is spoken as-is. */
    accessibilityLabel?: string;
    /** Bytes sent when the key is tapped. */
    send: string;
    /** True means holding the key repeats it (arrows, backspace-style keys). */
    repeat?: boolean;
}

/**
 * The reverse of decodeKeyBytes: printable bytes as-is, control bytes as the
 * human escapes, so an editor can show exactly what a key sends.
 */
export function encodeKeyBytes(bytes: string): string {
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

/**
 * Human escape encoding for key bytes, shared by the config file and the phone
 * editor: `\e` escape, `\n` newline, `\r` carriage return, `\t` tab, `\xHH` any
 * byte, `\\` a literal backslash. Returns null on an incomplete escape so a
 * typo fails loudly instead of sending a wrong key.
 */
export function decodeKeyBytes(text: string): string | null {
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
            if (!/^[0-9a-fA-F]{2}$/.test(hex)) return null;
            out += String.fromCharCode(parseInt(hex, 16));
            i += 2;
        } else if (next === '\\') out += '\\';
        else return null;
        i += 1;
    }
    return out;
}
