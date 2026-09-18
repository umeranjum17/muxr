import { describe, expect, it } from 'vitest';
import { DEFAULT_ROW_IDS, BUILTIN_KEY_CATALOG, bytesToEscape, escapeToBytes, modifiedSend, resolveKeyRow, type RowEntry } from './keyRow';

// The row a person sees is the arrangement they made on this device; until
// they make one, the built-in default stands.
describe('terminal key row resolution', () => {
    it('shows the built-in row until the device is customised, then the arrangement wins', () => {
        expect(resolveKeyRow(null).map((key) => key.label)).toEqual(
            DEFAULT_ROW_IDS.map((id) => BUILTIN_KEY_CATALOG[id].label),
        );

        // Their own row mixes catalog ids with a custom key whose bytes came in
        // through the editor's escape syntax.
        const custom: RowEntry[] = ['ctrl-c', { label: 'pwd', send: 'pwd\n' }];
        const resolved = resolveKeyRow(custom);
        expect(resolved.map((key) => key.label)).toEqual(['^C', 'pwd']);
        expect(resolved[1].send).toBe(escapeToBytes('pwd\n'));
        expect(resolved[1].accessibilityLabel).toBe('pwd');
    });

    it('drops unknown catalog ids instead of breaking the row, and refuses incomplete escapes', () => {
        expect(resolveKeyRow(['ctrl-c', 'no-such-key', 'pgup']).map((key) => key.label)).toEqual(['^C', 'pgup']);
        expect(escapeToBytes('\\e[15~')).toBe('\u001b[15~');
        expect(escapeToBytes('\\x0')).toBeNull();
        expect(escapeToBytes('')).toBeNull();
        // \x9b would reach the pty as two UTF-8 bytes, so it is refused outright.
        expect(escapeToBytes('\\x9b')).toBeNull();
        expect(bytesToEscape('\u001b[15~')).toBe('\\e[15~');
        expect(escapeToBytes(bytesToEscape('\u0003\\ok'))).toBe('\u0003\\ok');
    });

    // An armed modifier must reach every key that can encode it, and must not
    // silently send the bare key when it cannot.
    it('encodes armed modifiers across the catalog and refuses the chords a terminal cannot express', () => {
        const key = (id: string) => BUILTIN_KEY_CATALOG[id];

        // Arrows keep the exact bytes they used to carry as hardcoded variants.
        expect(modifiedSend(key('left'), true, false)).toBe('\u001b[1;5D');
        expect(modifiedSend(key('left'), false, true)).toBe('\u001b[1;2D');
        expect(modifiedSend(key('left'), true, true)).toBe('\u001b[1;6D');
        expect(modifiedSend(key('left'), false, false)).toBe('\u001b[D');

        // Keys that never honoured a modifier before now do.
        expect(modifiedSend(key('f5'), true, false)).toBe('\u001b[15;5~');
        expect(modifiedSend(key('f1'), true, false)).toBe('\u001b[1;5P');
        expect(modifiedSend(key('home'), false, true)).toBe('\u001b[1;2H');
        expect(modifiedSend(key('pgup'), true, true)).toBe('\u001b[5;6~');
        expect(modifiedSend({ label: 'b', accessibilityLabel: 'b', send: 'b' }, true, false)).toBe('\u0002');
        expect(modifiedSend(key('tab'), false, true)).toBe('\u001b[Z');

        // No encoding exists: the row dims these instead of sending them bare.
        expect(modifiedSend(key('enter'), true, false)).toBeNull();
        expect(modifiedSend(key('ctrl-c'), true, false)).toBeNull();
        expect(modifiedSend(key('esc'), false, true)).toBeNull();
        expect(modifiedSend({ label: 'pwd', accessibilityLabel: 'pwd', send: 'pwd\n' }, true, false)).toBeNull();
    });
});
