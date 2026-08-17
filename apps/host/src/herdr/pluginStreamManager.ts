/**
 * Persistent plugin stream runtime.
 *
 * A manifest-declared `host.stream` contribution becomes one sandboxed plugin
 * process behind a relay channel. The relay and phone see only the generic
 * realtime NDJSON contract; provider auth and event translation stay inside
 * the plugin process.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import WebSocket from 'ws';
import {
    encodeRealtimeFrame,
    issueWsTicket,
    parseRealtimeClientFrame,
    parseRealtimeHostFrame,
    realtimeSocketUrl,
    ticketSocketUrl,
    type Envelope,
    type RealtimeHostFrame,
} from '@muxr/contract';
import { v2EnvelopeSequence } from '@muxr/crypto';
import { HostV2Crypto, type HostedMachineKeys } from '../hostedE2ee.js';

const ATTACH_TIMEOUT_MS = 10_000;
const STREAM_IDLE_TIMEOUT_MS = 10 * 60_000;
const MAX_STREAM_LINE_BYTES = 128 * 1024;
const KILL_GRACE_MS = 2_000;
const MAX_STREAMS_PER_DEVICE = 2;
const MAX_STREAM_BUFFER_BYTES = 512 * 1024;

export interface PluginStreamTarget {
    pluginId: string;
    pluginRoot: string;
    entry: string;
}

interface StreamOptions {
    relayUrl: string;
    machineId: string;
    token?: string;
    hostedE2ee?: HostedMachineKeys;
}

interface Attachment {
    channel: string;
    sessionId?: string;
    deviceId?: string;
    process: ChildProcess;
    socket: WebSocket;
    idleTimer: NodeJS.Timeout;
    close: (reason?: string) => void;
    onClosed: () => void;
}

export class PluginStreamManager {
    private readonly attachments = new Map<string, Attachment>();
    private readonly attachingByDevice = new Map<string, number>();
    private readonly hosted: HostV2Crypto | undefined;

    constructor(private readonly options: StreamOptions) {
        this.hosted = options.hostedE2ee === undefined ? undefined : new HostV2Crypto(options.hostedE2ee);
    }

    async attach(params: {
        target: PluginStreamTarget;
        channel: string;
        stateDir: string;
        sessionId?: string;
        paneId?: string;
        cwd?: string;
        deviceId?: string;
        signal: AbortSignal;
        onClosed: () => void;
    }): Promise<void> {
        if (this.hosted !== undefined && (params.deviceId === undefined || this.options.hostedE2ee?.ingressKeys[params.deviceId] === undefined)) {
            throw new Error('plugin stream: hosted attach requires an active device grant');
        }
        if (params.signal.aborted) throw new Error('plugin stream revoked');
        const deviceKey = params.deviceId ?? 'local';
        const activeForDevice = [...this.attachments.values()].filter((entry) => (entry.deviceId ?? 'local') === deviceKey).length;
        const attachingForDevice = this.attachingByDevice.get(deviceKey) ?? 0;
        if (activeForDevice + attachingForDevice >= MAX_STREAMS_PER_DEVICE) throw new Error('plugin stream: device stream limit reached');
        this.attachingByDevice.set(deviceKey, attachingForDevice + 1);
        try {
        mkdirSync(params.stateDir, { recursive: true, mode: 0o700 });

        const socketUrl = this.options.token === undefined || this.options.token.startsWith('machinetok_')
            ? realtimeSocketUrl(this.options.relayUrl, {
                machineId: this.options.machineId,
                channel: params.channel,
                role: 'machine',
                ...(this.options.token === undefined ? {} : { token: this.options.token }),
            })
            : ticketSocketUrl(this.options.relayUrl, await issueWsTicket({
                relayUrl: this.options.relayUrl,
                credential: this.options.token,
                machineId: this.options.machineId,
                role: 'machine',
                transport: 'stream',
                channel: params.channel,
            }), 'stream');
        const socket = new WebSocket(socketUrl);
        await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(() => {
                socket.close();
                reject(new Error('plugin stream: relay did not accept the channel'));
            }, ATTACH_TIMEOUT_MS);
            socket.once('open', () => { clearTimeout(timer); resolve(); });
            socket.once('error', (error) => { clearTimeout(timer); reject(error); });
        });
        if (params.signal.aborted) {
            socket.close();
            throw new Error('plugin stream revoked');
        }

        const processGroup = process.platform !== 'win32';
        const child = spawn(process.execPath, [join(params.target.pluginRoot, params.target.entry)], {
            cwd: process.cwd(),
            detached: processGroup,
            env: {
                PATH: process.env.PATH,
                HOME: process.env.HOME,
                ...(process.env.MUXR_HOME ? { MUXR_HOME: process.env.MUXR_HOME } : {}),
                MUXR_PLUGIN_ID: params.target.pluginId,
                MUXR_PLUGIN_STATE_DIR: params.stateDir,
            },
            stdio: ['pipe', 'pipe', 'pipe'],
        });

        let finished = false;
        let gracefulCloseSent = false;
        let stderr = Buffer.alloc(0);
        const signalProcess = (signal: NodeJS.Signals): void => {
            try {
                if (child.pid === undefined) return;
                if (processGroup) process.kill(-child.pid, signal);
                else child.kill(signal);
            } catch { /* already gone */ }
        };
        const send = (frame: RealtimeHostFrame): void => {
            if (socket.readyState !== WebSocket.OPEN) return;
            if (frame.type === 'realtime.audio' && socket.bufferedAmount > MAX_STREAM_BUFFER_BYTES) return;
            const line = encodeRealtimeFrame(frame);
            if (this.hosted === undefined) {
                socket.send(line);
                return;
            }
            const payload = this.hosted.seal('stream', params.channel, line);
            const envelope: Envelope = {
                header: {
                    machineId: this.options.machineId,
                    senderId: this.options.machineId,
                    recipientId: '*',
                    channel: 'stream',
                    streamId: params.channel,
                    keyVersion: this.options.hostedE2ee!.keyVersion,
                    seq: v2EnvelopeSequence(payload),
                    at: Date.now(),
                },
                payload,
            };
            socket.send(JSON.stringify(envelope));
        };
        const armIdle = (): void => {
            attachment.idleTimer.refresh();
        };
        const finish = (reason?: string): void => {
            if (finished) return;
            finished = true;
            clearTimeout(attachment.idleTimer);
            params.signal.removeEventListener('abort', onAbort);
            if (reason !== undefined && socket.readyState === WebSocket.OPEN) {
                try { send({ type: 'realtime.closed', reason }); } catch { /* best effort */ }
            }
            if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) socket.close();
            if (this.attachments.get(params.channel) === attachment) this.attachments.delete(params.channel);
            attachment.onClosed();
        };
        const killChild = (): void => {
            if (child.exitCode !== null) return;
            signalProcess('SIGTERM');
            const killer = setTimeout(() => {
                if (child.exitCode === null) signalProcess('SIGKILL');
            }, KILL_GRACE_MS);
            killer.unref();
        };
        const onAbort = (): void => {
            killChild();
            finish('plugin revoked');
        };
        const attachment: Attachment = {
            channel: params.channel,
            ...(params.sessionId === undefined ? {} : { sessionId: params.sessionId }),
            ...(params.deviceId === undefined ? {} : { deviceId: params.deviceId }),
            process: child,
            socket,
            idleTimer: setTimeout(() => {
                killChild();
                finish('realtime stream idle');
            }, STREAM_IDLE_TIMEOUT_MS),
            close: (reason?: string) => {
                killChild();
                finish(reason);
            },
            onClosed: params.onClosed,
        };
        attachment.idleTimer.unref();
        const replaced = this.attachments.get(params.channel);
        if (replaced !== undefined) replaced.close('replaced by a newer stream');
        this.attachments.set(params.channel, attachment);
        params.signal.addEventListener('abort', onAbort, { once: true });
        if (params.signal.aborted) onAbort();

        child.stdin.on('error', () => attachment.close('plugin stream input failed'));
        child.stderr.on('data', (chunk: Buffer) => {
            stderr = Buffer.concat([stderr, chunk]);
            if (stderr.length > 32 * 1024) stderr = stderr.subarray(stderr.length - 32 * 1024);
        });
        let stdout = '';
        let stdoutBytes = 0;
        child.stdout.on('data', (chunk: Buffer) => {
            stdoutBytes += chunk.length;
            if (stdoutBytes > MAX_STREAM_LINE_BYTES) {
                attachment.close('plugin stream output exceeded its frame bound');
                return;
            }
            stdout += chunk.toString('utf8');
            const lines = stdout.split('\n');
            stdout = lines.pop() ?? '';
            stdoutBytes = Buffer.byteLength(stdout);
            for (const line of lines) {
                if (line.trim() === '') continue;
                try {
                    const frame = parseRealtimeHostFrame(JSON.parse(line));
                    send(frame);
                    if (frame.type === 'realtime.closed') gracefulCloseSent = true;
                    armIdle();
                } catch {
                    attachment.close('plugin stream emitted an invalid realtime frame');
                    return;
                }
            }
        });
        child.once('error', (error) => attachment.close(`plugin stream failed: ${error.message}`));
        child.once('close', (code) => {
            // Never forward stack traces or local paths: keep one clean line.
            const rawDetail = stderr.toString('utf8').trim();
            const exceptionLine = rawDetail.split('\n').map((line) => line.trim()).find((line) => /^(?:[A-Za-z]+Error|Error): /.test(line));
            const detail = Buffer.from(exceptionLine ?? rawDetail.split('\n')[0] ?? '').subarray(0, 400).toString('utf8')
                .replace(/file:\/\/\S+/g, 'plugin').replace(/[\u0000-\u001F\u007F]/g, ' ').trim();
            const finishChild = () => attachment.close(code === 0 ? undefined : detail === '' ? `plugin stream exited (${code ?? 'signal'})` : detail);
            // Let the encrypted graceful-close frame reach the phone before its
            // socket close event; decryption completes asynchronously there.
            if (code === 0 && gracefulCloseSent) {
                const timer = setTimeout(finishChild, 250);
                timer.unref();
            } else finishChild();
        });

        socket.on('message', (data: WebSocket.RawData) => {
            if (finished || this.attachments.get(params.channel) !== attachment || child.exitCode !== null) return;
            try {
                let text = String(data);
                if (this.hosted !== undefined) {
                    const envelope = JSON.parse(text) as Envelope;
                    if (envelope.header.machineId !== this.options.machineId
                        || envelope.header.senderId !== params.deviceId
                        || envelope.header.recipientId !== this.options.machineId
                        || envelope.header.channel !== 'stream'
                        || envelope.header.streamId !== params.channel
                        || envelope.header.keyVersion !== this.options.hostedE2ee?.keyVersion
                        || envelope.header.seq !== v2EnvelopeSequence(envelope.payload)) {
                        throw new Error('invalid hosted routing context');
                    }
                    text = this.hosted.open(params.deviceId!, 'stream', params.channel, envelope.payload);
                }
                const frame = parseRealtimeClientFrame(JSON.parse(text));
                child.stdin.write(`${JSON.stringify(frame)}\n`);
                armIdle();
            } catch {
                attachment.close('client sent an invalid realtime frame');
            }
        });
        socket.on('close', () => attachment.close());
        socket.on('error', () => attachment.close());

        try {
            child.stdin.write(`${JSON.stringify({
                type: 'realtime.open',
                ...(params.sessionId === undefined ? {} : { sessionId: params.sessionId }),
                ...(params.paneId === undefined ? {} : { paneId: params.paneId }),
                ...(params.cwd === undefined ? {} : { cwd: params.cwd }),
            })}\n`);
        } catch (error) {
            attachment.close(error instanceof Error ? error.message : String(error));
            throw error;
        }
        } finally {
            const remaining = (this.attachingByDevice.get(deviceKey) ?? 1) - 1;
            if (remaining <= 0) this.attachingByDevice.delete(deviceKey);
            else this.attachingByDevice.set(deviceKey, remaining);
        }
    }

    detach(channel: string, reason?: string): void {
        this.attachments.get(channel)?.close(reason);
    }

    closeSession(sessionId: string): void {
        for (const attachment of [...this.attachments.values()]) {
            if (attachment.sessionId === sessionId) attachment.close('session stopped');
        }
    }

    closeAll(): void {
        for (const attachment of [...this.attachments.values()]) attachment.close();
    }
}
