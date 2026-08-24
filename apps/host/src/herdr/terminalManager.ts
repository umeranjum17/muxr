/**
 * Terminal manager: one `herdr terminal session control` subprocess per
 * attached channel, piped to the relay channel socket verbatim.
 *
 * The frames on the socket ARE herdr's own NDJSON terminal protocol -- the only
 * host-generated frame is `terminal.ready`. Control mode is taken with
 * --takeover: the phone is the primary driver, and herdr hands the pane back to
 * the next desk attach.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import WebSocket from 'ws';
import { issueWsTicket, terminalSocketUrl, ticketSocketUrl, type Envelope } from '@muxr/contract';
import type { IdentityStore } from './identity.js';
import { v2EnvelopeSequence } from '@muxr/crypto';
import { HostV2Crypto, type HostedMachineKeys } from '../hostedE2ee.js';

export interface TerminalManagerOptions {
    relayUrl: string;
    machineId: string;
    token?: string;
    identity: IdentityStore;
    herdrBin?: string;
    hostedE2ee?: HostedMachineKeys;
}

interface Attachment {
    sessionId: string;
    paneId: string;
    mode: 'control' | 'observe';
    deviceId?: string;
    process: ChildProcess;
    socket: WebSocket;
    close: (reason?: string) => void;
}

const ATTACH_TIMEOUT_MS = 10_000;

export class TerminalManager {
    private readonly attachments = new Map<string, Attachment>();
    private readonly controlQueues = new Map<string, Promise<void>>();
    private readonly hosted: HostV2Crypto | undefined;

    constructor(private readonly options: TerminalManagerOptions) {
        this.hosted = options.hostedE2ee === undefined ? undefined : new HostV2Crypto(options.hostedE2ee);
    }

    async attach(params: {
        sessionId: string;
        channel: string;
        cols: number;
        rows: number;
        mode?: 'control' | 'observe';
        deviceId?: string;
        takeover?: boolean;
    }): Promise<{ paneId: string }> {
        if (this.hosted !== undefined && (params.deviceId === undefined || this.options.hostedE2ee?.ingressKeys[params.deviceId] === undefined)) {
            throw new Error('terminal: hosted attach requires an active device grant');
        }
        const record = this.options.identity.get(params.sessionId);
        if (record === undefined) throw new Error(`unknown session: ${params.sessionId}`);
        if ((params.mode ?? 'control') !== 'control') return this.attachNow(params);

        // Linearize same-pane control requests. The previous controller stays
        // live until its successor has a relay channel and herdr process.
        const previous = this.controlQueues.get(record.paneId) ?? Promise.resolve();
        const run = previous.catch(() => undefined).then(() => this.attachNow(params));
        const tail = run.then(() => undefined, () => undefined);
        this.controlQueues.set(record.paneId, tail);
        try {
            return await run;
        } finally {
            if (this.controlQueues.get(record.paneId) === tail) this.controlQueues.delete(record.paneId);
        }
    }

    private async attachNow(params: {
        sessionId: string;
        channel: string;
        cols: number;
        rows: number;
        mode?: 'control' | 'observe';
        deviceId?: string;
        takeover?: boolean;
    }): Promise<{ paneId: string }> {
        const record = this.options.identity.get(params.sessionId);
        if (record === undefined) throw new Error(`unknown session: ${params.sessionId}`);
        const mode = this.hosted !== undefined && params.deviceId !== undefined
            && this.options.hostedE2ee?.deviceAuthorities?.[params.deviceId] === 'observe'
            ? 'observe'
            : params.mode ?? 'control';
        if (mode === 'control' && this.hosted !== undefined) {
            const controller = [...this.attachments.values()].find((attachment) =>
                attachment.mode === 'control' && attachment.paneId === record.paneId,
            );
            if (controller !== undefined && controller.deviceId !== params.deviceId && params.takeover !== true) {
                throw new Error('terminal: pane is controlled by another device; explicit takeover required');
            }
        }

        const socketUrl = this.options.token === undefined || this.options.token.startsWith('machinetok_')
            ? terminalSocketUrl(this.options.relayUrl, {
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
                transport: 'terminal',
                channel: params.channel,
            }), 'terminal');
        const socket = new WebSocket(socketUrl);
        await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(() => {
                socket.close();
                reject(new Error('terminal: relay did not accept the channel'));
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

        const herdr = this.options.herdrBin ?? 'herdr';
        // Observe renders the pane without touching it: no takeover, no real-PTY
        // resize -- that is what makes the home screen's live preview cards free.
        const observe = mode === 'observe';
        const child = spawn(
            herdr,
            [
                'terminal',
                'session',
                observe ? 'observe' : 'control',
                record.paneId,
                ...(observe ? [] : ['--takeover']),
                '--cols',
                String(params.cols),
                '--rows',
                String(params.rows),
            ],
            { stdio: ['pipe', 'pipe', 'inherit'] },
        );
        // spawn() reports ENOENT asynchronously. Do not acknowledge the attach
        // request until Herdr actually starts: otherwise the reason is lost
        // before the phone joins and a permanent PATH fault looks like endless
        // network reconnecting.
        await new Promise<void>((resolve, reject) => {
            const cleanup = (): void => {
                child.off('spawn', onSpawn);
                child.off('error', onError);
            };
            const onSpawn = (): void => { cleanup(); resolve(); };
            const onError = (error: Error): void => {
                cleanup();
                socket.close();
                process.stderr.write(`terminal: could not start ${herdr}: ${error.message}\n`);
                reject(new Error(`terminal: could not start Herdr: ${error.message}`));
            };
            child.once('spawn', onSpawn);
            child.once('error', onError);
        });

        const attachment: Attachment = {
            sessionId: params.sessionId,
            paneId: record.paneId,
            mode,
            ...(params.deviceId === undefined ? {} : { deviceId: params.deviceId }),
            process: child,
            socket,
            close: () => undefined,
        };

        let finished = false;
        const removeInput = (): void => {
            socket.off('message', onInput);
        };
        const finish = (reason?: string): void => {
            if (finished) return;
            finished = true;
            removeInput();
            if (reason !== undefined && socket.readyState === WebSocket.OPEN) {
                const plaintext = JSON.stringify({ type: 'terminal.closed', reason });
                if (this.hosted === undefined) {
                    socket.send(plaintext);
                } else {
                    const payload = this.hosted.seal('terminal', params.channel, plaintext);
                    const envelope: Envelope = {
                        header: {
                            machineId: this.options.machineId,
                            senderId: this.options.machineId,
                            recipientId: '*',
                            channel: 'terminal',
                            streamId: params.channel,
                            keyVersion: this.options.hostedE2ee!.keyVersion,
                            seq: v2EnvelopeSequence(payload),
                            at: Date.now(),
                        },
                        payload,
                    };
                    socket.send(JSON.stringify(envelope));
                }
                socket.close();
            }
            if (this.attachments.get(params.channel) === attachment) this.attachments.delete(params.channel);
        };
        attachment.close = (reason?: string): void => {
            if (finished) return;
            if (reason === undefined) {
                finish();
                if (socket.readyState === WebSocket.OPEN) socket.close();
            } else {
                finish(reason);
            }
            try {
                child.stdin?.write(`${JSON.stringify({ type: 'terminal.release' })}\n`);
            } catch {
                /* stream already gone */
            }
            try {
                if (child.exitCode === null) child.kill();
            } catch {
                /* already dead */
            }
        };

        // Commit only after the successor is ready. Observe streams are never
        // displaced, and the old controller receives a final reason so its
        // client does not auto-reattach and steal control back.
        const replaced = this.attachments.get(params.channel);
        if (replaced !== undefined) replaced.close();
        if (mode === 'control') {
            for (const current of this.attachments.values()) {
                if (current.mode === 'control' && current.paneId === record.paneId) {
                    current.close('control moved to another device');
                }
            }
        }
        this.attachments.set(params.channel, attachment);

        const onInputError = (error: Error): void => {
            attachment.close(`herdr stream input failed: ${error.message}`);
        };
        const onInput = (data: WebSocket.RawData): void => {
            if (finished || this.attachments.get(params.channel) !== attachment || child.exitCode !== null) return;
            const input = child.stdin;
            if (input === null || input.destroyed || !input.writable) return;
            let text = String(data);
            if (text.trim().length === 0) return;
            try {
                if (this.hosted !== undefined) {
                    const envelope = JSON.parse(text) as Envelope;
                    if (envelope.header.machineId !== this.options.machineId
                        || envelope.header.senderId !== params.deviceId
                        || envelope.header.recipientId !== this.options.machineId
                        || envelope.header.channel !== 'terminal'
                        || envelope.header.streamId !== params.channel
                        || envelope.header.keyVersion !== this.options.hostedE2ee?.keyVersion
                        || envelope.header.seq !== v2EnvelopeSequence(envelope.payload)) {
                        throw new Error('terminal: invalid hosted routing context');
                    }
                    text = this.hosted.open(params.deviceId!, 'terminal', params.channel, envelope.payload);
                }
                input.write(`${text}\n`);
            } catch (error) {
                onInputError(error instanceof Error ? error : new Error(String(error)));
            }
        };
        // Writable failures such as EPIPE are asynchronous; try/catch around
        // write() cannot intercept them. Without an error owner Node terminates
        // the entire host, dropping every session and triggering a reconnect loop.
        child.stdin?.on('error', onInputError);

        // herdr stdout is NDJSON terminal.frame records; forward each line as-is.
        let buffer = '';
        child.stdout?.on('data', (chunk: Buffer) => {
            buffer += chunk.toString('utf8');
            const lines = buffer.split('\n');
            buffer = lines.pop() ?? '';
            for (const line of lines) {
                if (line.trim().length === 0 || socket.readyState !== WebSocket.OPEN) continue;
                if (this.hosted === undefined) {
                    socket.send(line);
                    continue;
                }
                const payload = this.hosted.seal('terminal', params.channel, line);
                const envelope: Envelope = {
                    header: {
                        machineId: this.options.machineId,
                        senderId: this.options.machineId,
                        recipientId: '*',
                        channel: 'terminal',
                        streamId: params.channel,
                        keyVersion: this.options.hostedE2ee!.keyVersion,
                        seq: v2EnvelopeSequence(payload),
                        at: Date.now(),
                    },
                    payload,
                };
                socket.send(JSON.stringify(envelope));
            }
        });

        // Client input is written to the control stream's stdin verbatim.
        // Observe streams are read-only; drop input silently.
        if (!observe) {
            socket.on('message', onInput);
        }

        child.on('exit', (code) => {
            finish(`herdr stream exited (${code ?? 'signal'})`);
        });
        // An unspawnable herdr binary (PATH drift, upgrade window) must not take
        // the whole host down with an unhandled 'error' event.
        child.on('error', (error) => {
            process.stderr.write(`terminal: could not start ${herdr}: ${error.message}\n`);
            finish(`herdr stream failed: ${error.message}`);
        });
        socket.on('close', () => {
            const remote = !finished;
            finish();
            if (remote && child.exitCode === null) child.kill();
        });
        socket.on('error', () => {
            const remote = !finished;
            finish();
            if (remote && child.exitCode === null) child.kill();
        });

        return { paneId: record.paneId };
    }

    detach(channel: string, authenticatedDeviceId?: string): void {
        const attachment = this.attachments.get(channel);
        if (attachment === undefined) return;
        if (authenticatedDeviceId !== undefined && attachment.deviceId !== authenticatedDeviceId) {
            throw new Error('terminal: channel belongs to another device');
        }
        attachment.close();
    }

    /** Kill every stream bound to a session (session.stop, host shutdown). */
    detachSession(sessionId: string): void {
        for (const [channel, attachment] of this.attachments) {
            if (attachment.sessionId === sessionId) this.detach(channel);
        }
    }

    closeAll(): void {
        for (const channel of [...this.attachments.keys()]) this.detach(channel);
    }
}
