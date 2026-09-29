import { describe, expect, it } from 'vitest';
import { localSettingsParse } from '../../catalog/application/localSettings';
import { cleanTerminalColorOverrides, resolveTerminalColors, terminalColorsFrom } from './terminalColors';

// Persisted Settings as the renderer receives them: useTerminalColors feeds
// cleanTerminalColorOverrides(stored) into resolveTerminalColors(defaults),
// so whatever survives cleaning is exactly what the terminal draws.
describe('terminal color overrides', () => {
    it('drops malformed persisted values before they reach the renderer', () => {
        const defaults = terminalColorsFrom({
            background: '#000000',
            foreground: '#ffffff',
            cursor: '#ffffff',
            selection: '#333333',
            ansi: Array.from({ length: 16 }, (_, index) => `#${index.toString(16).padStart(6, '0')}`),
        });
        const stored = {
            background: '#102030',
            foreground: 'not-a-color',
            cursor: '#12345',
            selection: 12345,
            ansi0: '#zzzzzz',
            ansi1: '#ff5555',
            ansi2: null,
            ansi3: { hex: '#00ff00' },
            ansi4: ['#00ff00'],
            ansi99: '#00ff00',
            backdrop: '#00ff00',
        };
        const overrides = cleanTerminalColorOverrides(stored);
        expect(overrides).toEqual({ background: '#102030', ansi1: '#ff5555' });

        const colors = resolveTerminalColors(defaults, overrides);
        expect(colors.background).toBe('#102030');
        expect(colors.ansi1).toBe('#ff5555');
        // Everything malformed falls back to the renderer default.
        expect(colors.foreground).toBe(defaults.foreground);
        expect(colors.cursor).toBe(defaults.cursor);
        expect(colors.selection).toBe(defaults.selection);
        expect(colors.ansi0).toBe(defaults.ansi0);
        for (const value of Object.values(colors)) {
            expect(value).toMatch(/^#[0-9a-f]{6}$/);
        }
    });

    it('keeps valid overrides when one persisted slot is corrupt', () => {
        // One corrupt slot must not wipe the others at load: the settings
        // schema carries every entry through, and cleaning drops only the bad one.
        const loaded = localSettingsParse({
            terminalColors: { background: '#102030', ansi1: '#ff5555', selection: 12345 },
        });
        expect(cleanTerminalColorOverrides(loaded.terminalColors)).toEqual({
            background: '#102030',
            ansi1: '#ff5555',
        });
    });
});
