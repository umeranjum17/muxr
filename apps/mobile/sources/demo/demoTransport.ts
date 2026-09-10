import type { OpenTerminalCommand, TerminalChannel } from '@/terminal/application/OpenTerminal';
import type { MuxrTransport } from '@/pairing/infrastructure/muxrClient';

/**
 * Demo transport selection. Native (and any non-demo context): the demo
 * does not exist here — selection is always false and construction throws.
 * The real selector lives in demoTransport.web.ts; Metro never ships it in
 * the native graph.
 */
export function isDemoTransport(): boolean {
    return false;
}

export function activateDemoTransport(): void {}

export function demoTransport(): MuxrTransport {
    throw new Error('demo replay is web-only');
}

export function isDemoTerminalSession(_sessionId: string): boolean {
    return false;
}

export function onDemoTransitionComplete(_listener: () => void): () => void {
    return () => {};
}

export function openDemoTerminal(_command: OpenTerminalCommand): Promise<TerminalChannel> {
    throw new Error('demo replay is web-only');
}
