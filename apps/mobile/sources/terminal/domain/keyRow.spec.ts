import { describe, expect, it } from 'vitest';
import { DEFAULT_ROW_IDS, BUILTIN_KEY_CATALOG, escapeToBytes, resolveKeyRow, type RowEntry } from './keyRow';

// The row a person sees is resolved from three layers that must stay in one
// order: their own arrangement on this device, then the operator's declared
// row from $MUXR_HOME/config.json, then the built-in default.
describe('terminal key row resolution', () => {
    it('follows the operator row when the phone has not customized, and the phone wins once it has', () => {
        // Nothing anywhere: the built-in default, the nine keys people know.
        expect(resolveKeyRow(null, undefined).map((key) => key.label)).toEqual(
            DEFAULT_ROW_IDS.map((id) => BUILTIN_KEY_CATALOG[id].label),
        );

        // Operator declared a row: every phone follows it verbatim.
        const operator = [
            { label: 'esc', accessibilityLabel: 'Escape', send: '\u001b' },
            { label: 'F5', send: '\u001b[15~' },
        ];
        expect(resolveKeyRow(null, operator).map((key) => key.label)).toEqual(['esc', 'F5']);

        // The person then arranges their own device: their row wins, mixing
        // catalog ids with a custom key whose bytes came in through the same
        // \e escape syntax the operator file speaks.
        const custom: RowEntry[] = ['ctrl-c', { label: 'pwd', send: 'pwd\n' }];
        const resolved = resolveKeyRow(custom, operator);
        expect(resolved.map((key) => key.label)).toEqual(['^C', 'pwd']);
        expect(resolved[1].send).toBe(escapeToBytes('pwd\n'));
        expect(resolved[1].accessibilityLabel).toBe('pwd');
    });

    it('drops unknown catalog ids instead of breaking the row, and refuses incomplete escapes', () => {
        expect(resolveKeyRow(['ctrl-c', 'no-such-key', 'pgup'], undefined).map((key) => key.label)).toEqual(['^C', 'pgup']);
        expect(escapeToBytes('\\e[15~')).toBe('\u001b[15~');
        expect(escapeToBytes('\\x0')).toBeNull();
        expect(escapeToBytes('')).toBeNull();
    });
});
