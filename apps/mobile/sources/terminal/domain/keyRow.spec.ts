import { describe, expect, it } from 'vitest';
import { DEFAULT_ROW_IDS, BUILTIN_KEY_CATALOG, bytesToEscape, escapeToBytes, resolveKeyRow, type RowEntry } from './keyRow';

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
        expect(bytesToEscape('\u001b[15~')).toBe('\\e[15~');
        expect(escapeToBytes(bytesToEscape('\u0003\\ok'))).toBe('\u0003\\ok');
    });
});
