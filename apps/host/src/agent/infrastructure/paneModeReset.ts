/**
 * Inject DEC private-mode resets into a pane's PTY as program output so Herdr
 * leaves the alternate screen and turns mouse reporting off. Writing through
 * the shell's stdout fd (or its tty) reaches the terminal parser without
 * typing into the command line.
 */

import { closeSync, existsSync, openSync, writeSync } from 'node:fs';
import { MODE_RESET_CSI } from './terminalModes.js';

export type PaneProcessSnapshot = {
    shellPid?: number | null;
    tty?: string | null;
    foregroundPids: number[];
};

/** Shell alone in the foreground — no child still driving the pane. */
export function foregroundIsShellOnly(info: PaneProcessSnapshot): boolean {
    const shellPid = info.shellPid;
    if (shellPid === undefined || shellPid === null || !Number.isInteger(shellPid) || shellPid <= 0) {
        return false;
    }
    const foreground = info.foregroundPids.filter((pid) => Number.isInteger(pid) && pid > 0);
    if (foreground.length === 0) return true;
    return foreground.every((pid) => pid === shellPid);
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
