/**
 * Browser preview, machine half.
 *
 * `listPreviewServers` finds local HTTP listeners. `attachPreview` joins a relay
 * preview channel and dials the chosen port on this machine's own loopback, so a
 * dev server bound to 127.0.0.1 needs no rebinding and is never exposed to the
 * network -- the only thing that leaves the machine is the relay socket the host
 * already holds open.
 */

import { connect, type Socket } from 'node:net';
import { readlink } from 'node:fs/promises';
import { isAbsolute, relative } from 'node:path';
import WebSocket from 'ws';
import {
    decodePreviewFrame,
    encodePreviewFrame,
    previewSocketUrl,
    PREVIEW_CLOSE,
    PREVIEW_DATA,
    type PreviewServer,
    issueWsTicket,
    ticketSocketUrl,
} from '@muxr/contract';
import { runMachineShell } from './runMachineShell.js';

const PROBE_TIMEOUT_MS = 1200;
const ATTACH_TIMEOUT_MS = 10_000;

interface Listener {
    port: number;
    bind: string;
    command: string;
    pid?: number;
}

/** `LISTEN 0 511 127.0.0.1:8080 0.0.0.0:* users:(("node",pid=4039084,fd=21))` */
export function parseSsListeners(stdout: string): Listener[] {
    const listeners: Listener[] = [];
    for (const line of stdout.split('\n')) {
        if (!line.startsWith('LISTEN')) continue;
        const fields = line.trim().split(/\s+/);
        const local = fields[3];
        if (local === undefined) continue;
        const split = splitHostPort(local);
        if (split === undefined) continue;
        const process = /users:\(\("([^"]+)",pid=(\d+)/.exec(line);
        listeners.push({
            port: split.port,
            bind: split.host,
            command: process?.[1] ?? '',
            ...(process?.[2] === undefined ? {} : { pid: Number(process[2]) }),
        });
    }
    return listeners;
}

/** `node 12345 umer 21u IPv4 0x1 0t0 TCP 127.0.0.1:8080 (LISTEN)` */
export function parseLsofListeners(stdout: string): Listener[] {
    const listeners: Listener[] = [];
    for (const line of stdout.split('\n')) {
        if (!line.includes('(LISTEN)')) continue;
        const fields = line.trim().split(/\s+/);
        const address = fields[fields.length - 2];
        const command = fields[0];
        const pid = Number(fields[1]);
        if (address === undefined || command === undefined) continue;
        const split = splitHostPort(address);
        if (split === undefined) continue;
        listeners.push({
            port: split.port,
            bind: split.host,
            command,
            ...(Number.isFinite(pid) ? { pid } : {}),
        });
    }
    return listeners;
}

/** Handles `127.0.0.1:8080`, `*:8081`, `0.0.0.0:3000` and `[::1]:9000`. */
function splitHostPort(value: string): { host: string; port: number } | undefined {
    const mark = value.lastIndexOf(':');
    if (mark <= 0) return undefined;
    const port = Number(value.slice(mark + 1));
    if (!Number.isInteger(port) || port <= 0 || port > 65535) return undefined;
    return { host: value.slice(0, mark), port };
}

async function readListeners(): Promise<Listener[]> {
    const command = process.platform === 'darwin'
        ? 'lsof -nP -iTCP -sTCP:LISTEN'
        : 'ss -ltnp';
    const result = await runMachineShell(command, process.cwd());
    if (result.stdout.trim() === '') return [];
    return process.platform === 'darwin'
        ? parseLsofListeners(result.stdout)
        : parseSsListeners(result.stdout);
}

/** A port is interesting only if something there answers HTTP. */
async function speaksHttp(port: number): Promise<boolean> {
    try {
        await fetch(`http://127.0.0.1:${port}/`, {
            method: 'HEAD',
            signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
        });
        return true;
    } catch {
        return false;
    }
}

export async function listPreviewServers(excludePort?: number, cwd?: string): Promise<PreviewServer[]> {
    const listeners = await readListeners();

    // A dual-stack server shows up once per address family. The tunnel dials
    // 127.0.0.1 regardless, so a second row for the same port is just noise.
    const byPort = new Map<number, Listener>();
    for (const listener of listeners) {
        if (listener.port === excludePort) continue;
        const seen = byPort.get(listener.port);
        // Prefer the row that names a process; that is the one worth showing.
        if (seen === undefined || (seen.command === '' && listener.command !== '')) {
            byPort.set(listener.port, listener);
        }
    }

    const candidates = [...byPort.values()];
    const isHttp = await Promise.all(candidates.map((listener) => speaksHttp(listener.port)));
    const http = candidates.filter((_, index) => isHttp[index] === true);
    if (cwd === undefined) return http.sort((a, b) => a.port - b.port);

    // Without a cwd the process cannot be tied to the project, so it stays out.
    const cwds = await Promise.all(http.map((listener) => processCwd(listener.pid)));
    return http
        .filter((_, index) => {
            const serverCwd = cwds[index];
            return serverCwd !== undefined && insideProject(cwd, serverCwd);
        })
        .sort((a, b) => a.port - b.port);
}

/** Where the listener process runs. Undefined when the OS will not say. */
export async function processCwd(pid: number | undefined): Promise<string | undefined> {
    if (pid === undefined) return undefined;
    if (process.platform !== 'darwin') {
        return await readlink(`/proc/${pid}/cwd`).catch(() => undefined);
    }
    const result = await runMachineShell(`lsof -a -p ${pid} -d cwd -Fn`, process.cwd());
    // `p4039084\nfcwd\nn/Users/umer/project`
    return /^n(.+)$/m.exec(result.stdout)?.[1];
}

/** Counts when either directory contains the other: a dev server is often run from the repo root while the session sits in a package, or the reverse. */
export function insideProject(sessionCwd: string, serverCwd: string): boolean {
    const within = (outer: string, inner: string): boolean => {
        const rel = relative(outer, inner);
        return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
    };
    return within(sessionCwd, serverCwd) || within(serverCwd, sessionCwd);
}

export interface AttachPreviewOptions {
    relayUrl: string;
    machineId: string;
    channel: string;
    port: number;
    token?: string;
}

/**
 * Join `channel` and forward it to `port`. Resolves once the relay socket is
 * open, so a failure to reach the relay surfaces as a failed request instead of
 * a preview that silently never loads.
 */
export async function attachPreview(options: AttachPreviewOptions): Promise<null> {
    const socketUrl = options.token === undefined || options.token.startsWith('machinetok_')
        ? previewSocketUrl(options.relayUrl, {
            machineId: options.machineId,
            channel: options.channel,
            role: 'machine',
            ...(options.token === undefined ? {} : { token: options.token }),
        })
        : ticketSocketUrl(options.relayUrl, await issueWsTicket({
            relayUrl: options.relayUrl,
            credential: options.token,
            machineId: options.machineId,
            role: 'machine',
            transport: 'preview',
            channel: options.channel,
        }), 'preview');
    const socket = new WebSocket(socketUrl);
    socket.binaryType = 'nodebuffer';

    await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
            socket.close();
            reject(new Error(`preview: relay did not accept the channel within ${ATTACH_TIMEOUT_MS}ms`));
        }, ATTACH_TIMEOUT_MS);
        socket.once('open', () => {
            clearTimeout(timer);
            resolve();
        });
        socket.once('error', (error: Error) => {
            clearTimeout(timer);
            reject(error);
        });
    });

    const connections = new Map<number, Socket>();

    const send = (connId: number, flag: number, payload?: Uint8Array): void => {
        if (socket.readyState === WebSocket.OPEN) {
            socket.send(encodePreviewFrame(connId, flag, payload));
        }
    };

    const drop = (connId: number): void => {
        const existing = connections.get(connId);
        if (existing === undefined) return;
        connections.delete(connId);
        existing.destroy();
    };

    socket.on('message', (raw: Buffer) => {
        const frame = decodePreviewFrame(new Uint8Array(raw));
        if (frame === undefined) return;

        if (frame.flag === PREVIEW_CLOSE) {
            drop(frame.connId);
            return;
        }

        let upstream = connections.get(frame.connId);
        if (upstream === undefined) {
            // The device opened a new TCP connection; mirror it against the dev
            // server. Writes before connect land in node's own socket buffer.
            upstream = connect(options.port, '127.0.0.1');
            connections.set(frame.connId, upstream);
            // ponytail: no backpressure. A large bundle buffers in ws until it
            // drains. Pause the socket on socket.bufferedAmount if it bites.
            upstream.on('data', (chunk: Buffer) => send(frame.connId, PREVIEW_DATA, new Uint8Array(chunk)));
            upstream.on('close', () => {
                connections.delete(frame.connId);
                send(frame.connId, PREVIEW_CLOSE);
            });
            upstream.on('error', () => {
                connections.delete(frame.connId);
                send(frame.connId, PREVIEW_CLOSE);
            });
        }
        if (frame.payload.length > 0) upstream.write(frame.payload);
    });

    // The relay closes this side when the device goes away. Without the sweep
    // every dev-server connection from this preview would leak.
    const teardown = (): void => {
        for (const connId of [...connections.keys()]) drop(connId);
    };
    socket.on('close', teardown);
    socket.on('error', teardown);

    return null;
}
