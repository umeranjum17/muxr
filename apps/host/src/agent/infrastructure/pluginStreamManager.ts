/**
 * Persistent plugin stream runtime.
 *
 * A manifest-declared `host.stream` contribution becomes one trusted local plugin
 * process behind a relay channel. Backend code is not OS-sandboxed. The relay and phone see only the generic
 * realtime NDJSON contract; provider auth and event translation stay inside
 * the plugin process.
 */

import { spawn, type ChildProcess, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import {
    encodeRealtimeFrame,
    MAX_REALTIME_CLOSE_REASON_BYTES,
    parseRealtimeClientFrame,
    parseRealtimeHostFrame,
    realtimePluginPublicContext,
    type RealtimePluginOpenFrame,
    type RealtimePluginPublicContext,
    type RealtimeHostFrame,
} from '@muxr/contract';
import type { PeerBroker } from '../../peer/index.js';
import type { RealtimeCodingCoordinator, RealtimeCoordinatorAccess } from './realtimeCoordinator.js';
import type { VoiceStreamTransport } from '../application/sessionSource.js';

const OPEN = 1;
const CLOSING = 2;
const CLOSED = 3;
const STREAM_IDLE_TIMEOUT_MS = 10 * 60_000;
const MAX_STREAM_LINE_BYTES = 128 * 1024;
const KILL_GRACE_MS = 2_000;
const MAX_STREAMS_PER_DEVICE = 2;
const MAX_STREAM_BUFFER_BYTES = 512 * 1024;

function safeStreamReason(value: unknown): string {
    const clean = String(value ?? 'Voice stream unavailable.')
        .normalize('NFKC')
        .replace(/["'](?:[A-Za-z][A-Za-z0-9]*_)*(?:api[_-]?key|access[_-]?token|token|secret|password)["']\s*[:=]\s*["']?[^"'{}\s,;]+["']?/gi, '[credential redacted]')
        .replace(/\b(Bearer)\s+[A-Za-z0-9._~+/-]{12,}/gi, '$1 [redacted]')
        .replace(/\b(?:[A-Za-z][A-Za-z0-9]*_)+(?:api_key|token|secret|password)\s*[:=]\s*[^\s,;]+/gi, '[credential redacted]')
        .replace(/\b(api[_-]?key|token|secret|password)\s*[:=]\s*[^\s,;]+/gi, '$1=[redacted]')
        .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/gi, '[credential redacted]')
        .replace(/\beyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/gi, '[credential redacted]')
        .replace(/\b(?:pph?_[a-z0-9]+|w[0-9A-Za-z]+:(?:p|t)[0-9A-Za-z]+|(?:machine|device|session|pane|rel|peer)[-_][a-z0-9_-]{6,})\b/gi, '[internal reference]')
        .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi, '[internal reference]')
        .replace(/file:\/\/\S+/g, '[path hidden]')
        .replace(/(?<![A-Za-z0-9_/])\/(?!\/)(?:[^\s\/<>'"]+\/)+[^\s\/<>'"]+/g, '[path hidden]')
        .replace(/\b[A-Za-z]:\\(?:[^\s\\]+\\)+[^\s,;]*/g, '[path hidden]')
        .replace(/[\u0000-\u001F\u007F]/g, ' ')
        .trim();
    const bytes = Buffer.from(clean, 'utf8');
    return (bytes.length <= MAX_REALTIME_CLOSE_REASON_BYTES
        ? clean
        : bytes.subarray(0, MAX_REALTIME_CLOSE_REASON_BYTES).toString('utf8')).trim() || 'Voice stream unavailable.';
}

export interface PluginStreamTarget {
    pluginId: string;
    pluginRoot: string;
    entry: string;
    peerBroker?: boolean;
    codingCoordinator?: boolean;
}

interface StreamOptions {
    peerBroker?: PeerBroker;
    codingCoordinator?: RealtimeCodingCoordinator;
}

class LinkStreamSocket extends EventEmitter {
    readyState = OPEN;
    bufferedAmount = 0;
    private readonly decoder = new TextDecoder();
    private buffer = '';
    private readonly early: Buffer[] = [];
    private earlyBytes = 0;
    private paused = false;
    private resumeWaiter: (() => void) | undefined;

    constructor(private readonly stream: VoiceStreamTransport) {
        super();
        stream.onData = async (chunk) => {
            this.buffer += this.decoder.decode(chunk, { stream: true });
            const lines = this.buffer.split('\n');
            this.buffer = lines.pop() ?? '';
            for (const line of lines) {
                const frame = Buffer.from(line);
                if (this.listenerCount('message') === 0) {
                    this.earlyBytes += frame.length;
                    if (this.earlyBytes > 16 * 1024 * 1024) { this.close(); return; }
                    this.early.push(frame);
                } else this.emit('message', frame);
                if (this.paused) await new Promise<void>((resolve) => { this.resumeWaiter = resolve; });
            }
        };
        stream.onEnd = () => {
            this.resume();
            this.readyState = CLOSED;
            this.emit('close');
        };
    }

    flushEarly(): void {
        for (const frame of this.early.splice(0)) this.emit('message', frame);
        this.earlyBytes = 0;
        if (this.readyState === CLOSED) this.emit('close');
    }

    send(data: string, callback?: (error?: Error) => void): void {
        const bytes = Buffer.byteLength(data) + 1;
        this.bufferedAmount += bytes;
        void this.stream.write(`${data}\n`).then(
            () => { this.bufferedAmount = Math.max(0, this.bufferedAmount - bytes); callback?.(); },
            (error: unknown) => {
                this.bufferedAmount = Math.max(0, this.bufferedAmount - bytes);
                callback?.(error instanceof Error ? error : new Error(String(error)));
            },
        );
    }

    close(): void {
        if (this.readyState !== OPEN) return;
        this.readyState = CLOSING;
        this.stream.end();
    }

    pause(): void { this.paused = true; }
    resume(): void {
        this.paused = false;
        this.resumeWaiter?.();
        this.resumeWaiter = undefined;
    }
}

interface Attachment {
    channel: string;
    sessionId?: string;
    deviceId?: string;
    process: ChildProcess;
    socket: LinkStreamSocket;
    idleTimer: NodeJS.Timeout;
    close: (reason?: string) => void;
    onClosed: () => void;
}

export class PluginStreamManager {
    private readonly attachments = new Map<string, Attachment>();
    private readonly attachingByDevice = new Map<string, number>();
    constructor(private readonly options: StreamOptions) {}

    async attach(params: {
        target: PluginStreamTarget;
        channel: string;
        stateDir: string;
        sessionId?: string;
        paneId?: string;
        cwd?: string;
        publicContext?: RealtimePluginPublicContext;
        deviceId?: string;
        signal: AbortSignal;
        onClosed: () => void;
        transport: VoiceStreamTransport;
    }): Promise<void> {
        if (params.signal.aborted) throw new Error('plugin stream revoked');
        const deviceKey = params.deviceId ?? 'local';
        const activeForDevice = [...this.attachments.values()].filter((entry) => (entry.deviceId ?? 'local') === deviceKey).length;
        const attachingForDevice = this.attachingByDevice.get(deviceKey) ?? 0;
        if (activeForDevice + attachingForDevice >= MAX_STREAMS_PER_DEVICE) throw new Error('plugin stream: device stream limit reached');
        this.attachingByDevice.set(deviceKey, attachingForDevice + 1);
        try {
        mkdirSync(params.stateDir, { recursive: true, mode: 0o700 });

        const socket = new LinkStreamSocket(params.transport);
        if (params.signal.aborted) {
            socket.close();
            throw new Error('plugin stream revoked');
        }

        const processGroup = process.platform !== 'win32';
        // Least-ambient routing only: unapproved/non-voice children do not receive
        // this token. Enabled backends still run as the host user and are trusted
        // local code; the token is not isolation from a malicious enabled plugin.
        // The caller's own session travels with the capability, so the broker can
        // name the sender through the host instead of trusting the plugin.
        const peerCaller = params.sessionId === undefined ? {} : { sessionId: params.sessionId };
        const peerAccess = params.target.peerBroker === true ? this.options.peerBroker?.issueCapability(peerCaller) : undefined;
        let codingAccess: RealtimeCoordinatorAccess | undefined;
        if (params.target.codingCoordinator === true) {
            codingAccess = this.options.codingCoordinator?.issueCapability({
                provider: params.target.pluginId,
                ...(params.sessionId === undefined ? {} : { sessionId: params.sessionId }),
                ...(params.cwd === undefined ? {} : { cwd: params.cwd }),
            });
        }
        let child: ChildProcessWithoutNullStreams;
        try {
            child = spawn(process.execPath, [join(params.target.pluginRoot, params.target.entry)], {
                cwd: process.cwd(),
                detached: processGroup,
                env: {
                    PATH: process.env.PATH,
                    HOME: process.env.HOME,
                    ...(process.env.MUXR_HOME ? { MUXR_HOME: process.env.MUXR_HOME } : {}),
                    ...(process.env.CODEX_HOME ? { CODEX_HOME: process.env.CODEX_HOME } : {}),
                    ...(process.env.MUXR_CODEX_BIN ? { MUXR_CODEX_BIN: process.env.MUXR_CODEX_BIN } : {}),
                    MUXR_PLUGIN_ID: params.target.pluginId,
                    MUXR_PLUGIN_STATE_DIR: params.stateDir,
                    ...(peerAccess === undefined ? {} : {
                        MUXR_PEER_BROKER_SOCKET: peerAccess.socketPath,
                        MUXR_PEER_BROKER_CAPABILITY: peerAccess.capability,
                    }),
                    ...(codingAccess === undefined ? {} : {
                        MUXR_VOICE_COORDINATOR_SOCKET: codingAccess.socketPath,
                        MUXR_VOICE_COORDINATOR_CAPABILITY: codingAccess.capability,
                    }),
                },
                stdio: ['pipe', 'pipe', 'pipe'],
            });
        } catch (error) {
            if (peerAccess !== undefined) this.options.peerBroker?.revokeCapability(peerAccess.capability);
            if (codingAccess !== undefined) this.options.codingCoordinator?.revokeCapability(codingAccess.capability);
            socket.close();
            throw error;
        }

        let finished = false;
        let gracefulCloseSent = false;
        let stderr = Buffer.alloc(0);
        let stdoutPaused = false;
        let socketPaused = false;
        // Audio must never be dropped: a provider reply bursts several times
        // faster than a slow phone downlink drains. Pause the plugin's stdout
        // and let pipe backpressure hold the reply until the socket catches up.
        const resumeStdoutIfDrained = (): void => {
            if (!finished && stdoutPaused && socket.bufferedAmount <= MAX_STREAM_BUFFER_BYTES / 2) {
                stdoutPaused = false;
                child.stdout.resume();
            }
        };
        const pauseStdoutIfNeeded = (): void => {
            if (!stdoutPaused && socket.bufferedAmount > MAX_STREAM_BUFFER_BYTES) {
                stdoutPaused = true;
                child.stdout.pause();
            }
        };
        const resumeSocketInput = (): void => {
            socketPaused = false;
            if (!finished && socket.readyState === OPEN) socket.resume();
        };
        const signalProcess = (signal: NodeJS.Signals): void => {
            try {
                if (child.pid === undefined) return;
                if (processGroup) process.kill(-child.pid, signal);
                else child.kill(signal);
            } catch { /* already gone */ }
        };
        const send = (frame: RealtimeHostFrame): boolean => {
            if (socket.readyState !== OPEN) return false;
            socket.send(encodeRealtimeFrame(frame), (error) => {
                if (error) attachment.close('plugin stream disconnected');
                else resumeStdoutIfDrained();
            });
            pauseStdoutIfNeeded();
            return true;
        };
        const armIdle = (): void => {
            attachment.idleTimer.refresh();
        };
        const finish = (reason?: string): void => {
            if (finished) return;
            finished = true;
            child.stdin.off('drain', resumeSocketInput);
            clearTimeout(attachment.idleTimer);
            params.signal.removeEventListener('abort', onAbort);
            if (reason !== undefined && socket.readyState === OPEN) {
                try { send({ type: 'realtime.closed', reason }); } catch { /* best effort */ }
            }
            if (socket.readyState === OPEN || socket.readyState === CLOSING) socket.close();
            if (this.attachments.get(params.channel) === attachment) this.attachments.delete(params.channel);
            if (peerAccess !== undefined) this.options.peerBroker?.revokeCapability(peerAccess.capability);
            if (codingAccess !== undefined) this.options.codingCoordinator?.revokeCapability(codingAccess.capability);
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
        let stdout: Buffer<ArrayBufferLike> = Buffer.alloc(0);
        child.stdout.on('data', (chunk: Buffer) => {
            stdout = stdout.length === 0 ? chunk : Buffer.concat([stdout, chunk]);
            let offset = 0;
            for (;;) {
                const newline = stdout.indexOf(0x0a, offset);
                if (newline === -1) break;
                const line = stdout.subarray(offset, newline);
                offset = newline + 1;
                if (line.length > MAX_STREAM_LINE_BYTES) {
                    attachment.close('plugin stream output exceeded its frame bound');
                    return;
                }
                const text = line.toString('utf8');
                if (text.trim() === '') continue;
                try {
                    const parsed = parseRealtimeHostFrame(JSON.parse(text));
                    const frame = parsed.type === 'realtime.closed' && parsed.reason !== undefined
                        ? { ...parsed, reason: safeStreamReason(parsed.reason) }
                        : parsed.type === 'realtime.state' && parsed.detail !== undefined
                          ? { ...parsed, detail: safeStreamReason(parsed.detail) }
                          : parsed;
                    if (!send(frame)) {
                        attachment.close('plugin stream disconnected');
                        return;
                    }
                    if (frame.type === 'realtime.closed') gracefulCloseSent = true;
                    armIdle();
                } catch {
                    attachment.close('plugin stream emitted an invalid realtime frame');
                    return;
                }
            }
            stdout = offset === 0 ? stdout : Buffer.from(stdout.subarray(offset));
            if (stdout.length > MAX_STREAM_LINE_BYTES) attachment.close('plugin stream output exceeded its frame bound');
        });
        child.once('error', (error) => attachment.close(`plugin stream failed: ${safeStreamReason(error.message)}`));
        child.once('close', (code) => {
            // Never forward stack traces or local paths: keep one clean line.
            const rawDetail = stderr.toString('utf8').trim();
            const exceptionLine = rawDetail.split('\n').map((line) => line.trim()).find((line) => /^(?:[A-Za-z]+Error|Error): /.test(line));
            const detail = safeStreamReason(Buffer.from(exceptionLine ?? rawDetail.split('\n')[0] ?? '').subarray(0, 400).toString('utf8'));
            const finishChild = () => {
                if (code === 0) {
                    attachment.close(undefined);
                    return;
                }
                if (detail === '') {
                    attachment.close(`plugin stream exited (${code ?? 'signal'})`);
                    return;
                }
                attachment.close(detail);
            };
            // Let the encrypted graceful-close frame reach the phone before its
            // socket close event; decryption completes asynchronously there.
            if (code === 0 && gracefulCloseSent) {
                const timer = setTimeout(finishChild, 250);
                timer.unref();
            } else finishChild();
        });

        socket.on('message', (data: Buffer) => {
            if (finished || this.attachments.get(params.channel) !== attachment || child.exitCode !== null) return;
            try {
                const frame = parseRealtimeClientFrame(JSON.parse(String(data)));
                if (!child.stdin.write(`${JSON.stringify(frame)}\n`) && !socketPaused) {
                    socketPaused = true;
                    socket.pause();
                    child.stdin.once('drain', resumeSocketInput);
                }
                armIdle();
            } catch {
                attachment.close('client sent an invalid realtime frame');
            }
        });
        socket.on('close', () => attachment.close());
        socket.on('error', () => attachment.close());
        socket.flushEarly();
        if (finished) throw new Error('plugin stream disconnected before attach');

        try {
            const open: RealtimePluginOpenFrame = {
                type: 'realtime.open',
                ...(params.sessionId === undefined ? {} : { sessionId: params.sessionId }),
                ...(params.paneId === undefined ? {} : { paneId: params.paneId }),
                ...(params.cwd === undefined ? {} : { cwd: params.cwd }),
                ...(params.publicContext === undefined ? {} : { publicContext: realtimePluginPublicContext(params.publicContext.sessions) }),
            };
            if (!child.stdin.write(`${JSON.stringify(open)}\n`) && !socketPaused) {
                socketPaused = true;
                socket.pause();
                child.stdin.once('drain', resumeSocketInput);
            }
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
