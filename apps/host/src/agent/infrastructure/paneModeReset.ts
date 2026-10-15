/**
 * Inject DEC private-mode resets into a pane's PTY as program output so Herdr
 * leaves the alternate screen and turns mouse reporting off. Writing through
 * the shell's stdout fd (or its tty) reaches the terminal parser without
 * typing into the command line.
 */

import { execFileSync } from 'node:child_process';
import { closeSync, existsSync, openSync, readFileSync, writeSync } from 'node:fs';
import { MODE_RESET_CSI } from './terminalModes.js';

export type PaneProcessSnapshot = {
    shellPid?: number | null;
    tty?: string | null;
    foregroundPids: number[];
};

/** The pane's shell pid when Herdr reported one usable. */
export function shellPidOf(info: PaneProcessSnapshot): number | undefined {
    const pid = info.shellPid;
    return pid !== null && pid !== undefined && Number.isInteger(pid) && pid > 0 ? pid : undefined;
}

/** The pane's foreground programs — the pane's own shell is not one of them. */
export function foregroundProgramPids(info: PaneProcessSnapshot): number[] {
    const shellPid = shellPidOf(info);
    return info.foregroundPids.filter((pid) => Number.isInteger(pid) && pid > 0 && pid !== shellPid);
}

/**
 * Whether a recorded program pid has gone. A program the user stopped (^Z) or
 * backgrounded still exists here, so its terminal modes stay its own; only a
 * program that left the machine is gone.
 */
export function programIsGone(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return false;
    } catch (error) {
        return (error as NodeJS.ErrnoException).code === 'ESRCH';
    }
}

/**
 * Whether the pane's shell still has a child. A stopped (^Z) or backgrounded
 * program is one, so a pane whose shell still has a job under it keeps its
 * modes; only a shell with nothing below it is safe to reset. A list that
 * cannot be read reads as "has a child": a program that cannot be ruled out is
 * never disturbed, and the caller retries on the next gesture.
 */
export function shellHasLiveChild(shellPid: number | null | undefined): boolean {
    if (shellPid === null || shellPid === undefined || !Number.isInteger(shellPid) || shellPid <= 0) return true;
    try {
        return readFileSync(`/proc/${shellPid}/task/${shellPid}/children`, 'utf8').trim().length > 0;
    } catch {
        /* Not a /proc host. */
    }
    try {
        const listing = execFileSync('ps', ['-A', '-o', 'ppid=,pid='], { encoding: 'utf8', timeout: 2_000 });
        return listing.split('\n').some((line) => Number.parseInt(line, 10) === shellPid);
    } catch {
        return true;
    }
}

/**
 * Write the mode-reset CSI as output on the pane PTY. Prefers the live shell
 * stdout fd on Linux, then an explicit tty path. Returns whether a write landed.
 */
export function writeModeResetToPane(info: PaneProcessSnapshot): boolean {
    const reset = Buffer.from(MODE_RESET_CSI, 'utf8');
    const paths: string[] = [];
    if (typeof info.tty === 'string' && info.tty.length > 0) paths.push(info.tty);
    if (info.shellPid !== undefined && info.shellPid !== null && info.shellPid > 0) {
        paths.push(`/proc/${info.shellPid}/fd/1`);
    }
    for (const path of paths) {
        try {
            if (!path.startsWith('/proc/') && !existsSync(path)) continue;
            const fd = openSync(path, 'w');
            try {
                writeSync(fd, reset);
                return true;
            } finally {
                closeSync(fd);
            }
        } catch {
            /* try the next path */
        }
    }
    return false;
}
