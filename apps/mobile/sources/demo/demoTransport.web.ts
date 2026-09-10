import type { OpenTerminalCommand, TerminalChannel } from '@/terminal/application/OpenTerminal';
import type { MuxrTransport } from '@/pairing/infrastructure/muxrClient';
import { demoClient } from './demoClient';
import { isDemoPathname } from './demoGuard';

/**
 * Web demo transport selection. Active only on the unpaired /demo route —
 * never inside a paired session. The deterministic backend (records, client,
 * memory terminal) enters the web graph through here; the memory terminal
 * itself stays behind a dynamic import so it loads only on the demo route.
 *
 * Activation is sticky per page load: opening a session navigates away from
 * /demo, but the replay backend must stay selected for the whole loop.
 * Only the demo route sets it, and the route refuses paired contexts, so a
 * paired session can never inherit it without a reload (which re-gates).
 */
let active = false;

export function activateDemoTransport(): void {
    active = true;
}

export function isDemoTransport(): boolean {
    return active || isDemoPathname();
}

export function demoTransport(): MuxrTransport {
    return demoClient;
}

export function isDemoTerminalSession(sessionId: string): boolean {
    return isDemoTransport() && demoClient.knows(sessionId);
}

export async function openDemoTerminal(command: OpenTerminalCommand): Promise<TerminalChannel> {
    const { openDemoTerminalChannel } = await import('./demoTerminalChannel');
    return openDemoTerminalChannel(command);
}
