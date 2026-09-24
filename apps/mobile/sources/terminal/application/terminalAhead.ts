/**
 * The terminal a committed page turn is heading for, opened while the page is
 * still settling, so the host's round trip and the first frame overlap the
 * animation instead of following it.
 *
 * Only a committed turn opens one. A control attach focuses the pane on the
 * desk and takes it over: here that is the arriving pane's own attach started
 * a few hundred milliseconds sooner, never something a peek may do.
 */

import { openTerminal, type TerminalChannel } from './OpenTerminal';

/** A claim that never comes -- the page never mounted -- gives the pane back. */
const UNCLAIMED_MS = 5_000;

export interface TerminalAhead {
    size: { cols: number; rows: number };
    channel: Promise<TerminalChannel>;
    controller: AbortController;
}

let grid: { cols: number; rows: number } | undefined;
let opening: (TerminalAhead & { sessionId: string; timer: ReturnType<typeof setTimeout> }) | undefined;

/** Every terminal on this phone is laid out at one size; this is the last one. */
export function rememberTerminalGrid(cols: number, rows: number): void {
    if (cols > 0 && rows > 0) grid = { cols, rows };
}

/** The grid a pane will be laid out in once this phone attaches to it. */
export function terminalGrid(): { cols: number; rows: number } | undefined {
    return grid;
}

export function openTerminalAhead(sessionId: string): void {
    releaseTerminalAhead();
    if (grid === undefined) return;
    const controller = new AbortController();
    const channel = openTerminal({ agentRoute: sessionId, signal: controller.signal, size: grid });
    // A failed open is the arriving view's to report once it claims it.
    channel.catch(() => undefined);
    opening = { sessionId, size: grid, channel, controller, timer: setTimeout(releaseTerminalAhead, UNCLAIMED_MS) };
}

/** The terminal a page turn already opened for this pane, taken once. */
export function claimTerminalAhead(sessionId: string): TerminalAhead | undefined {
    const held = opening;
    if (held === undefined || held.sessionId !== sessionId) return undefined;
    clearTimeout(held.timer);
    opening = undefined;
    return { size: held.size, channel: held.channel, controller: held.controller };
}

function releaseTerminalAhead(): void {
    const held = opening;
    opening = undefined;
    if (held === undefined) return;
    clearTimeout(held.timer);
    // Aborting closes the channel whether the open has finished or not.
    held.controller.abort();
}
