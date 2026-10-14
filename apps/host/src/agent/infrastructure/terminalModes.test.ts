import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { describe, expect, it } from 'vitest';
import { foregroundIsShellOnly, shellHasLiveChild, shellPidOf } from './paneModeReset.js';
import {
    MODE_RESET_CSI,
    applyPrivateModeBytes,
    freshTerminalModes,
    shouldProbeModeRestore,
    shouldResetStaleModes,
    shouldSendWheelReports,
} from './terminalModes.js';

describe('terminal mode wheel gate and stale-mode reset', () => {
    it('sends wheel reports only while mouse reporting is known on', () => {
        expect(shouldSendWheelReports(false, true)).toBe(true);
        expect(shouldSendWheelReports(false, false)).toBe(false);
        expect(shouldSendWheelReports(false, undefined)).toBe(false);
        expect(shouldSendWheelReports(true, true)).toBe(false);
        expect(shouldSendWheelReports(undefined, true)).toBe(false);
    });

    it('tracks mouse and alternate-screen modes from DECSET/DECRST', () => {
        let modes = freshTerminalModes();
        expect(shouldResetStaleModes(modes)).toBe(false);
        expect(shouldProbeModeRestore(false, modes)).toBe(true);
        expect(shouldProbeModeRestore(true, modes)).toBe(false);
        expect(shouldProbeModeRestore(undefined, modes)).toBe(false);

        modes = applyPrivateModeBytes(modes, "ready\x1b[?1049h\x1b[?1000h\x1b[?1006h");
        expect(modes).toEqual({ mouseReporting: true, alternateScreen: true });
        expect(shouldResetStaleModes(modes)).toBe(true);

        modes = applyPrivateModeBytes(modes, MODE_RESET_CSI);
        expect(modes).toEqual({ mouseReporting: false, alternateScreen: false });
        expect(shouldResetStaleModes(modes)).toBe(false);
        expect(shouldProbeModeRestore(false, modes)).toBe(false);

        // Combined private-mode list, and mouse without alternate screen.
        modes = applyPrivateModeBytes(freshTerminalModes(), '\x1b[?1000;1006h');
        expect(modes.mouseReporting).toBe(true);
        expect(modes.alternateScreen).toBeUndefined();
        expect(shouldResetStaleModes(modes)).toBe(true);
        modes = applyPrivateModeBytes(modes, '\x1b[?1000;1006l');
        expect(modes.mouseReporting).toBe(false);
    });

    it('reads the shell as alone only from a rounded pid', () => {
        expect(shellPidOf({ shellPid: 10, foregroundPids: [] })).toBe(10);
        expect(shellPidOf({ shellPid: null, foregroundPids: [] })).toBeUndefined();
        expect(shellPidOf({ foregroundPids: [] })).toBeUndefined();
        expect(foregroundIsShellOnly({ shellPid: 10, foregroundPids: [10] })).toBe(true);
        expect(foregroundIsShellOnly({ shellPid: 10, foregroundPids: [10, 99] })).toBe(false);
        expect(foregroundIsShellOnly({ shellPid: 10, foregroundPids: [] })).toBe(true);
        expect(foregroundIsShellOnly({ foregroundPids: [10] })).toBe(false);
    });

    it.runIf(process.platform === 'linux')('keeps a stopped child and forgets a reaped one', async () => {
        const parent = spawn('bash', ['-c', 'sleep 30; :'], { stdio: 'ignore', detached: true });
        try {
            await once(parent, 'spawn');
            await waitUntil(() => shellHasLiveChild(parent.pid));
            process.kill(-parent.pid!, 'SIGSTOP');
            // A ^Z'd program keeps its pid, so its terminal modes are its own.
            expect(shellHasLiveChild(parent.pid)).toBe(true);
            process.kill(-parent.pid!, 'SIGKILL');
            await once(parent, 'exit');
            await waitUntil(() => !shellHasLiveChild(parent.pid));
            expect(shellHasLiveChild(parent.pid)).toBe(false);
        } finally {
            if (parent.exitCode === null && parent.signalCode === null) {
                try {
                    process.kill(-parent.pid!, 'SIGKILL');
                } catch {
                    /* already gone */
                }
            }
        }
    });
});

async function waitUntil(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!predicate()) {
        if (Date.now() > deadline) throw new Error('condition never held');
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
}
