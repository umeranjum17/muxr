import { describe, expect, it } from 'vitest';
import { foregroundIsShellOnly } from './paneModeReset.js';
import {
    MODE_RESET_CSI,
    applyPrivateModeBytes,
    freshTerminalModes,
    shouldProbeModeRestore,
    shouldResetStaleModes,
    shouldSendWheelReports,
} from './terminalModes.js';

describe('terminal mode wheel gate and stale-mode reset', () => {
    it('sends wheel reports when Herdr has no scrollback unless mouse reporting is known off', () => {
        expect(shouldSendWheelReports(false, true)).toBe(true);
        expect(shouldSendWheelReports(false, undefined)).toBe(true);
        expect(shouldSendWheelReports(false, false)).toBe(false);
        expect(shouldSendWheelReports(true, true)).toBe(false);
        expect(shouldSendWheelReports(undefined, true)).toBe(false);
    });

    it('tracks mouse and alternate-screen modes from DECSET/DECRST and resets when the shell alone holds them', () => {
        let modes = freshTerminalModes();
        expect(shouldProbeModeRestore(false, modes, true)).toBe(true);
        expect(shouldProbeModeRestore(false, modes, false)).toBe(false);

        modes = applyPrivateModeBytes(modes, "ready\x1b[?1049h\x1b[?1000h\x1b[?1006h");
        expect(modes).toEqual({ mouseReporting: true, alternateScreen: true });
        expect(shouldResetStaleModes(modes, false)).toBe(false);
        expect(shouldResetStaleModes(modes, true)).toBe(true);
        expect(foregroundIsShellOnly({ shellPid: 10, foregroundPids: [10] })).toBe(true);
        expect(foregroundIsShellOnly({ shellPid: 10, foregroundPids: [10, 99] })).toBe(false);

        modes = applyPrivateModeBytes(modes, MODE_RESET_CSI);
        expect(modes).toEqual({ mouseReporting: false, alternateScreen: false });
        expect(shouldResetStaleModes(modes, true)).toBe(false);
        expect(shouldProbeModeRestore(false, modes, true)).toBe(false);

        // Combined private-mode list, and mouse without alternate screen.
        modes = applyPrivateModeBytes(freshTerminalModes(), '\x1b[?1000;1006h');
        expect(modes.mouseReporting).toBe(true);
        expect(modes.alternateScreen).toBeUndefined();
        expect(shouldResetStaleModes(modes, true)).toBe(true);
        modes = applyPrivateModeBytes(modes, '\x1b[?1000;1006l');
        expect(modes.mouseReporting).toBe(false);
    });
});
