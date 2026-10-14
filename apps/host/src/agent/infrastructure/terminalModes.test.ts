import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { describe, expect, it } from 'vitest';
import type { TerminalSession } from '@byokit/herdr';
import type { TerminalPipe } from '../../machine/index.js';
import { foregroundProgramPids, programIsGone, shellPidOf } from './paneModeReset.js';
import { TerminalManager } from './terminalManager.js';
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

    it('reads the pane shell pid and the foreground programs it owns', () => {
        expect(shellPidOf({ shellPid: 10, foregroundPids: [] })).toBe(10);
        expect(shellPidOf({ shellPid: null, foregroundPids: [] })).toBeUndefined();
        expect(shellPidOf({ foregroundPids: [] })).toBeUndefined();
        expect(foregroundProgramPids({ shellPid: 10, foregroundPids: [10] })).toEqual([]);
        expect(foregroundProgramPids({ shellPid: 10, foregroundPids: [10, 99] })).toEqual([99]);
        expect(foregroundProgramPids({ shellPid: 10, foregroundPids: [0, 99] })).toEqual([99]);
    });

    it('reports a stopped pid as present and a killed one as gone', async () => {
        const stopped = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
        const killed = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
        try {
            await Promise.all([once(stopped, 'spawn'), once(killed, 'spawn')]);
            stopped.kill('SIGSTOP');
            killed.kill('SIGKILL');
            await once(killed, 'exit');
            await waitFor(() => programIsGone(killed.pid!));
            // The stopped program keeps its pid, and the gone one is gone
            // whatever else the pane still runs.
            expect(programIsGone(stopped.pid!)).toBe(false);
            expect(programIsGone(killed.pid!)).toBe(true);
        } finally {
            for (const child of [stopped, killed]) {
                if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
            }
        }
    });

    it('keeps a stopped program and resets before the first wheel after it is gone', async () => {
        const program = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
        await once(program, 'spawn');
        const pid = program.pid!;
        const restores: string[] = [];
        const session = createSession();
        const pipe = createPipe();
        const manager = new TerminalManager({
            resolvePane: async () => 'pane-1',
            focusSession: async () => undefined,
            readPaneScroll: async () => ({ offsetFromBottom: 0, maxOffsetFromBottom: 0 }),
            paneForegroundPids: async () => [pid],
            restorePaneTerminalModes: async (paneId) => {
                restores.push(paneId);
                return true;
            },
            openTerminal: () => session,
        });
        try {
            await manager.attach({ sessionId: 'session-1', channel: 'channel-1', cols: 80, rows: 24, socket: pipe });
            session.emit(modeFrame());
            await waitFor(() => scrollStates(pipe) === 1);

            // Stopped is not gone: the modes stay the program's and a swipe is
            // still handed over as its wheel report.
            program.kill('SIGSTOP');
            expect(programIsGone(pid)).toBe(false);
            pipe.push(oneRowScroll());
            await waitFor(() => wheelSent(session));
            await waitFor(() => scrollStates(pipe) === 2);
            expect(restores).toEqual([]);

            // Gone: the next swipe resets the modes instead of handing the
            // wheel to the shell, which would type `64;19;6M` at its prompt.
            session.sent.length = 0;
            program.kill('SIGKILL');
            await once(program, 'exit');
            await waitFor(() => programIsGone(pid));
            pipe.push(oneRowScroll());
            for (let i = 0; i < 10; i++) await Promise.resolve();
            expect(restores).toEqual(['pane-1']);
            expect(wheelSent(session)).toBe(false);
        } finally {
            manager.closeAll();
            if (program.exitCode === null && program.signalCode === null) program.kill('SIGKILL');
        }
    });
});

function createSession(): TerminalSession & { sent: string[]; emit: (line: string) => void } {
    const listeners = new Set<(line: string) => void>();
    const sent: string[] = [];
    return {
        ready: Promise.resolve(),
        onFrame(listener) {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
        send(line) {
            sent.push(line);
        },
        close: () => undefined,
        pause: () => undefined,
        resume: () => undefined,
        exited: new Promise<{ code: number | null; stderrTail: string }>(() => undefined),
        sent,
        emit(line) {
            for (const listener of [...listeners]) listener(line);
        },
    };
}

function createPipe(): TerminalPipe & { sent: string[]; push: (line: string) => void } {
    const listeners = new Set<(line: string) => void>();
    const sent: string[] = [];
    return {
        isOpen: true,
        send(line) {
            sent.push(line);
        },
        onLine(listener) {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
        onEnd: () => () => undefined,
        close: () => undefined,
        sent,
        push(line) {
            for (const listener of [...listeners]) listener(line);
        },
    };
}

/** A full repaint that turns on the modes a fullscreen program owns. */
function modeFrame(): string {
    return JSON.stringify({
        type: 'terminal.frame',
        full: true,
        bytes: Buffer.from('\x1b[?1049h\x1b[?1000h', 'latin1').toString('base64'),
    });
}

function oneRowScroll(): string {
    return JSON.stringify({ type: 'terminal.scroll', direction: 'up', lines: 1, column: 1, row: 1 });
}

function wheelSent(session: { sent: string[] }): boolean {
    return session.sent.some((line) => line.includes('"terminal.scroll"'));
}

function scrollStates(pipe: { sent: string[] }): number {
    return pipe.sent.filter((line) => line.includes('terminal.scroll-state')).length;
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!predicate()) {
        if (Date.now() > deadline) throw new Error('condition never held');
        await new Promise((resolve) => setTimeout(resolve, 5));
    }
}
