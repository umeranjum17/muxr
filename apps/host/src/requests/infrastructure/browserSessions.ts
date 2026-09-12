/**
 * Host adapter for the broker-owned browser service.
 *
 * The service (plugins/browser/session-service.mjs) is the sole authority
 * over the agent's browser and its ownership machine; this adapter is a thin
 * relay between the device request plane and the service's owner-only control
 * socket. It adds nothing to the decision: it forwards `browser.session.*`
 * with the caller's device identity, and the service enforces ownership
 * generation, the take barrier, input permits and -- for `signal` -- the
 * separately pinned browser-service grant that this host cannot read.
 *
 * Feature detection is fail-closed: with no service socket, every call
 * answers with a plain "no browser service" error rather than pretending a
 * session exists. Nothing here logs or returns a port, provider id, token,
 * session handle or capability secret.
 */

import { connect, type Socket } from 'node:net';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { BrowserSessionStatus } from '@muxr/contract';

const REQUEST_TIMEOUT_MS = 30_000;
const MAX_REPLY_BYTES = 256 * 1024;

export function browserServiceDir(): string {
    const configured = process.env.MUXR_BROWSER_SERVICE_DIR?.trim();
    if (configured) return configured;
    const home = process.env.HOME?.trim() || homedir();
    return join(home, '.muxr', 'browser-service');
}

export function browserServiceSocketPath(): string {
    return join(browserServiceDir(), 'control.sock');
}

/** A relayed service error carries the ownership state it observed, id-free. */
export interface BrowserServiceError extends Error {
    state?: string;
    generation?: number;
}

export interface BrowserSessionAdapter {
    available(): boolean;
    status(session: string, deviceId: string): Promise<BrowserSessionStatus>;
    take(params: TransitionParams, deviceId: string): Promise<BrowserSessionStatus>;
    pause(params: TransitionParams, deviceId: string): Promise<BrowserSessionStatus>;
    resume(params: TransitionParams, deviceId: string): Promise<BrowserSessionStatus>;
    return(params: TransitionParams, deviceId: string): Promise<BrowserSessionStatus>;
    signal(params: SignalParams, deviceId: string): Promise<{ message?: string }>;
}

interface TransitionParams {
    session: string;
    expectedGeneration: number;
    command: string;
}

interface SignalParams {
    session: string;
    generation: number;
    message: string;
}

function once(socketPath: string, op: string, params: Record<string, unknown>): Promise<unknown> {
    return new Promise((resolve, reject) => {
        const id = randomUUID();
        let input = '';
        let settled = false;
        const socket: Socket = connect(socketPath);
        const timer = setTimeout(() => {
            if (settled) return;
            settled = true;
            socket.destroy();
            reject(new Error('the browser service did not answer'));
        }, REQUEST_TIMEOUT_MS);
        const settle = (action: () => void): void => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            action();
        };
        socket.once('error', () => settle(() => reject(new Error('this computer has no browser service'))));
        socket.on('connect', () => socket.write(`${JSON.stringify({ id, op, params })}\n`));
        socket.on('data', (chunk) => {
            input += chunk.toString('utf8');
            if (Buffer.byteLength(input) > MAX_REPLY_BYTES) {
                settle(() => reject(new Error('the browser service reply is too large')));
                socket.destroy();
                return;
            }
            const newline = input.indexOf('\n');
            if (newline === -1) return;
            socket.end();
            let reply: { id?: string; ok?: boolean; data?: unknown; error?: string; state?: string; generation?: number };
            try {
                reply = JSON.parse(input.slice(0, newline));
            } catch {
                settle(() => reject(new Error('the browser service reply is invalid')));
                return;
            }
            if (reply.id !== id) {
                settle(() => reject(new Error('the browser service reply is invalid')));
                return;
            }
            if (reply.ok === true) {
                settle(() => resolve(reply.data));
                return;
            }
            const error: BrowserServiceError = new Error(typeof reply.error === 'string' && reply.error !== '' ? reply.error : 'browser session request failed');
            if (typeof reply.state === 'string') error.state = reply.state;
            if (typeof reply.generation === 'number') error.generation = reply.generation;
            settle(() => reject(error));
        });
    });
}

/** Low-level call to the service control socket. Fail-closed when it is not running. */
export function callBrowserService(op: string, params: Record<string, unknown>, socketPath = browserServiceSocketPath()): Promise<unknown> {
    if (!existsSync(socketPath)) return Promise.reject(new Error('this computer has no browser service'));
    return once(socketPath, op, params);
}

export function browserServiceAvailable(socketPath = browserServiceSocketPath()): boolean {
    return existsSync(socketPath);
}

export function createBrowserSessionAdapter(options: { socketPath?: string } = {}): BrowserSessionAdapter {
    const socketPath = options.socketPath ?? browserServiceSocketPath();
    const call = (op: string, params: Record<string, unknown>): Promise<unknown> => callBrowserService(op, params, socketPath);
    const status = (data: unknown): BrowserSessionStatus => data as BrowserSessionStatus;
    return {
        available: () => existsSync(socketPath),
        status: async (session, deviceId) => status(await call('session.status', { session, deviceId })),
        take: async (params, deviceId) => status(await call('session.take', { ...params, deviceId })),
        pause: async (params, deviceId) => status(await call('session.pause', { ...params, deviceId })),
        resume: async (params, deviceId) => status(await call('session.resume', { ...params, deviceId })),
        return: async (params, deviceId) => status(await call('session.return', { ...params, deviceId })),
        signal: async (params, deviceId) => (await call('session.signal', { ...params, deviceId })) as { message?: string },
    };
}
