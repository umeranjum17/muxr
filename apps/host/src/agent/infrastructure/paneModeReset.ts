/**
 * Inject DEC private-mode resets into a pane's PTY as program output so Herdr
 * leaves the alternate screen and turns mouse reporting off. Writing through
 * the shell's stdout fd (or its tty) reaches the terminal parser without
 * typing into the command line.
 */

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

/** Shell alone in the foreground — no child still driving the pane. */
export function foregroundIsShellOnly(info: PaneProcessSnapshot): boolean {
    const shellPid = shellPidOf(info);
    if (shellPid === undefined) return false;
    const foreground = info.foregroundPids.filter((pid) => Number.isInteger(pid) && pid > 0);
    if (foreground.length === 0) return true;
    return foreground.every((pid) => pid === shellPid);
}

/**
 * A child of the shell is still in the pane — running, backgrounded or
 * stopped. A ^Z'd program keeps its pid here, so its terminal modes are left
 * alone; the kernel list of the shell's children is one small file read.
 * An unreadable list reads as empty so a platform without /proc falls back to
 * the foreground check.
 */
export function shellHasLiveChild(shellPid: number | null | undefined): boolean {
    if (shellPid === null || shellPid === undefined || !Number.isInteger(shellPid) || shellPid <= 0) return false;
    try {
        return readFileSync(`/proc/${shellPid}/task/${shellPid}/children`, 'utf8').trim().length > 0;
    } catch {
        return false;
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
