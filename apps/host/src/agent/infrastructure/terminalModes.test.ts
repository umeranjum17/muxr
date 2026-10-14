import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { describe, expect, it } from 'vitest';
import type { TerminalSession } from '@byokit/herdr';
import type { TerminalPipe } from '../../machine/index.js';
import { foregroundProgramPids, programIsGone, shellPidOf } from './paneModeReset.js';
import { wheelReportsAllowed } from './terminalModes.js';
import { TerminalManager } from './terminalManager.js';

describe('terminal wheel gate and stale-mode reset', () => {
    it('sends a wheel report only while a program, not the pane shell, holds the pane', () => {
        expect(wheelReportsAllowed([42])).toBe(true);
        expect(wheelReportsAllowed([])).toBe(false);
        // No answer yet (no probe wired, or a probe that failed): as before.
        expect(wheelReportsAllowed(undefined)).toBe(true);
    });

    it('reads the pane shell pid out of the foreground Herdr reports', () => {
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

    it('gates the wheel on the pane foreground and clears only a gone program', async () => {
        const first = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
        const second = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
        await Promise.all([once(first, 'spawn'), once(second, 'spawn')]);
        const firstPid = first.pid!;
        let foreground: number[] = [];
        const restores: string[] = [];
        const session = createSession();
        const pipe = createPipe();
        const manager = new TerminalManager({
            resolvePane: async () => 'pane-1',
            focusSession: async () => undefined,
            readPaneScroll: async () => ({ offsetFromBottom: 0, maxOffsetFromBottom: 0 }),
            paneForegroundPids: async () => foreground,
            restorePaneTerminalModes: async (paneId) => {
                restores.push(paneId);
                return true;
            },
            openTerminal: () => session,
        });
        let publishes = 0;
        const swipe = async (): Promise<void> => {
            session.sent.length = 0;
            publishes += 1;
            pipe.push(oneRowScroll());
            await waitFor(() => scrollStates(pipe) === publishes);
        };
        try {
            await manager.attach({ sessionId: 'session-1', channel: 'channel-1', cols: 80, rows: 24, socket: pipe });
            // No DECSET frame is ever sent: who holds the pane decides, not a
            // mode Herdr never reports back.
            publishes += 1;
            session.emit(screenFrame());
            await waitFor(() => scrollStates(pipe) === publishes);
            expect(restores).toEqual([]);

            // The pane's own shell holds it: the swipe is dropped, nothing cleared.
            await swipe();
            expect(wheelSent(session)).toBe(false);
            expect(restores).toEqual([]);

            // A program holds it: the swipe is that program's wheel report.
            foreground = [firstPid];
            await swipe();
            expect(wheelSent(session)).toBe(true);
            expect(restores).toEqual([]);

            // Stopped: the shell holds the pane again but the pid is still there,
            // so the program keeps its screen.
            first.kill('SIGSTOP');
            foreground = [];
            await swipe();
            expect(wheelSent(session)).toBe(false);
            expect(restores).toEqual([]);

            // Gone: the swipe clears what the program left and is not handed over.
            first.kill('SIGKILL');
            await once(first, 'exit');
            await waitFor(() => programIsGone(firstPid));
            await swipe();
            expect(wheelSent(session)).toBe(false);
            expect(restores).toEqual(['pane-1']);

            // A different program holds it now: its pid replaces the gone one,
            // so the swipe is its wheel and nothing is cleared.
            foreground = [second.pid!];
            await swipe();
            expect(wheelSent(session)).toBe(true);
            expect(restores).toEqual(['pane-1']);
        } finally {
            manager.closeAll();
            for (const child of [first, second]) {
                if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
            }
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

/** Herdr's full repaint for a pane that holds no scrollback. */
function screenFrame(): string {
    return JSON.stringify({
        type: 'terminal.frame',
        full: true,
        bytes: Buffer.from('SCREEN pane-1', 'latin1').toString('base64'),
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
