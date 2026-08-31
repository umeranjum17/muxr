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
import { v2EnvelopeSequence } from '@muxr/crypto';
import { HostV2Crypto, type HostedMachineKeys, deviceTableIsObserve, ticketWsCredential } from '../../machine/index.js';
import { HerdrGraphicsBridge, type HerdrGraphicsPointer } from './herdrGraphicsBridge.js';

export interface TerminalManagerOptions {
    relayUrl: string;
    machineId: string;
    token?: string;
    resolvePane: (sessionId: string) => Promise<string>;
    herdrBin?: string;
    hostedE2ee?: HostedMachineKeys;
}

interface Attachment {
    channel: string;
    sessionId: string;
    paneId: string;
    mode: 'control' | 'observe';
    deviceId?: string;
    process: ChildProcess;
    socket: WebSocket;
    cols: number;
    rows: number;
    cellWidthPx: number | undefined;
    cellHeightPx: number | undefined;
    close: (reason?: string) => void;
}

const ATTACH_TIMEOUT_MS = 10_000;

export class TerminalManager {
    private readonly attachments = new Map<string, Attachment>();
    private readonly controlQueues = new Map<string, Promise<void>>();
    private readonly hosted: HostV2Crypto | undefined;
    private graphics: HerdrGraphicsBridge | undefined;
    private graphicsOpening: Promise<void> | undefined;
    private graphicsCloseTimer: ReturnType<typeof setTimeout> | undefined;

    constructor(private readonly options: TerminalManagerOptions) {
        this.hosted = options.hostedE2ee === undefined ? undefined : new HostV2Crypto(options.hostedE2ee);
    }

    async attach(params: {
        sessionId: string;
        channel: string;
        cols: number;
        rows: number;
        cellWidthPx?: number;
        cellHeightPx?: number;
        mode?: 'control' | 'observe';
        deviceId?: string;
        takeover?: boolean;
    }): Promise<{ paneId: string }> {
        if (this.hosted !== undefined && (params.deviceId === undefined || this.options.hostedE2ee?.ingressKeys[params.deviceId] === undefined)) {
            throw Object.assign(new Error('terminal: hosted attach requires an active device grant'), { code: 'e2ee-required' });
        }
        const paneId = await this.options.resolvePane(params.sessionId);
        if ((params.mode ?? 'control') !== 'control') return this.attachNow(params, paneId);

        // Linearize same-pane control requests. The previous controller stays
        // live until its successor has a relay channel and herdr process.
        const previous = this.controlQueues.get(paneId) ?? Promise.resolve();
        const run = previous.catch(() => undefined).then(() => this.attachNow(params, paneId));
        const tail = run.then(() => undefined, () => undefined);
        this.controlQueues.set(paneId, tail);
        try {
            return await run;
        } finally {
            if (this.controlQueues.get(paneId) === tail) this.controlQueues.delete(paneId);
        }
    }

    private async attachNow(params: {
        sessionId: string;
        channel: string;
        cols: number;
        rows: number;
        cellWidthPx?: number;
        cellHeightPx?: number;
        mode?: 'control' | 'observe';
        deviceId?: string;
        takeover?: boolean;
    }, paneId: string): Promise<{ paneId: string }> {
        const mode = this.hosted !== undefined && deviceTableIsObserve(this.options.hostedE2ee?.deviceAuthorities, params.deviceId)
            ? 'observe'
            : params.mode ?? 'control';
        if (mode === 'control' && this.hosted !== undefined) {
            const controller = [...this.attachments.values()].find((attachment) =>
                attachment.mode === 'control' && attachment.paneId === paneId,
            );
            if (controller !== undefined && controller.deviceId !== params.deviceId && params.takeover !== true) {
                throw Object.assign(new Error('terminal: pane is controlled by another device; explicit takeover required'), { code: 'takeover' });
            }
        }

        const credential = ticketWsCredential(this.options.token);
        let socketUrl: string;
        if (credential === undefined) {
            socketUrl = terminalSocketUrl(this.options.relayUrl, {
                machineId: this.options.machineId,
                channel: params.channel,
                role: 'machine',
                ...(this.options.token === undefined ? {} : { token: this.options.token }),
            });
        } else {
            socketUrl = ticketSocketUrl(this.options.relayUrl, await issueWsTicket({
                relayUrl: this.options.relayUrl,
                credential,
                machineId: this.options.machineId,
                role: 'machine',
                transport: 'terminal',
                channel: params.channel,
            }), 'terminal');
        }
        const socket = new WebSocket(socketUrl);
        await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(() => {
                socket.close();
                reject(Object.assign(new Error('terminal: relay did not accept the channel'), { code: 'socket-timeout' }));
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
                paneId,
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
                reject(Object.assign(new Error(`terminal: could not start Herdr: ${error.message}`), { code: 'unavailable' }));
            };
            child.once('spawn', onSpawn);
            child.once('error', onError);
        });

        const attachment: Attachment = {
            channel: params.channel,
            sessionId: params.sessionId,
            paneId,
            mode,
            ...(params.deviceId === undefined ? {} : { deviceId: params.deviceId }),
            process: child,
            socket,
            cols: params.cols,
            rows: params.rows,
            cellWidthPx: params.cellWidthPx,
            cellHeightPx: params.cellHeightPx,
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
            this.graphics?.unregister(params.channel);
            this.scheduleGraphicsClose();
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
                if (current.mode === 'control' && current.paneId === paneId) {
                    current.close('control moved to another device');
                }
            }
        }
        this.attachments.set(params.channel, attachment);
        if (!observe) this.activateGraphics(attachment, params);

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
                const frame = JSON.parse(text) as { type?: string; cols?: number; rows?: number; cellWidthPx?: number; cellHeightPx?: number } & Partial<HerdrGraphicsPointer>;
                if (frame.type === 'terminal.resize' && typeof frame.cols === 'number' && typeof frame.rows === 'number') {
                    this.activateGraphics(attachment, {
                        cols: frame.cols,
                        rows: frame.rows,
                        ...(frame.cellWidthPx === undefined ? {} : { cellWidthPx: frame.cellWidthPx }),
                        ...(frame.cellHeightPx === undefined ? {} : { cellHeightPx: frame.cellHeightPx }),
                    });
                }
                if (frame.type === 'terminal.pointer'
                    && (frame.phase === 'down' || frame.phase === 'move' || frame.phase === 'up')
                    && typeof frame.x === 'number' && typeof frame.y === 'number'
                    && typeof frame.width === 'number' && typeof frame.height === 'number') {
                    const pointer = { phase: frame.phase, x: frame.x, y: frame.y, width: frame.width, height: frame.height };
                    for (const report of this.graphics?.pointerInput(attachment.channel, pointer) ?? []) {
                        input.write(`${JSON.stringify({ type: 'terminal.input', bytes: report.toString('base64') })}\n`);
                    }
                    return;
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
                if (line.trim().length === 0) continue;
                this.sendToPhone(attachment, line);
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

        return { paneId };
    }

    private activateGraphics(attachment: Attachment, size: { cols: number; rows: number; cellWidthPx?: number; cellHeightPx?: number }): void {
        attachment.cols = size.cols;
        attachment.rows = size.rows;
        attachment.cellWidthPx = size.cellWidthPx;
        attachment.cellHeightPx = size.cellHeightPx;
        if (size.cellWidthPx === undefined || size.cellHeightPx === undefined
            || ![size.cols, size.rows, size.cellWidthPx, size.cellHeightPx].every((value) => Number.isFinite(value) && value > 0)) return;
        if (this.graphicsCloseTimer !== undefined) {
            clearTimeout(this.graphicsCloseTimer);
            this.graphicsCloseTimer = undefined;
        }
        if (this.graphics !== undefined) {
            this.registerGraphics(attachment, this.graphics);
            return;
        }
        if (this.graphicsOpening !== undefined) return;
        const opening = HerdrGraphicsBridge.open(
            this.options.herdrBin === undefined ? {} : { herdrBin: this.options.herdrBin },
        )
            .then((graphics) => {
                if (this.graphicsOpening !== opening) { graphics.close(); return; }
                this.graphics = graphics;
                for (const current of this.attachments.values()) {
                    if (current.mode === 'control') this.registerGraphics(current, graphics);
                }
            })
            .catch((error: unknown) => {
                process.stderr.write(`terminal graphics unavailable: ${error instanceof Error ? error.message : String(error)}\n`);
            })
            .finally(() => { if (this.graphicsOpening === opening) this.graphicsOpening = undefined; });
        this.graphicsOpening = opening;
    }

    private registerGraphics(attachment: Attachment, graphics: HerdrGraphicsBridge): void {
        if (attachment.cellWidthPx === undefined || attachment.cellHeightPx === undefined) return;
        graphics.register({
            channel: attachment.channel,
            paneId: attachment.paneId,
            cols: attachment.cols,
            rows: attachment.rows,
            cellWidthPx: attachment.cellWidthPx,
            cellHeightPx: attachment.cellHeightPx,
            write: (frame) => {
                if (this.attachments.get(attachment.channel) === attachment) this.sendToPhone(attachment, frame);
            },
        });
    }

    private scheduleGraphicsClose(): void {
        if (this.graphics === undefined || this.graphics.hasRegistrations() || this.graphicsCloseTimer !== undefined) return;
        this.graphicsCloseTimer = setTimeout(() => {
            this.graphicsCloseTimer = undefined;
            if (this.graphics?.hasRegistrations() === false) {
                this.graphics.close();
                this.graphics = undefined;
            }
        }, 60_000);
    }

    private sendToPhone(attachment: Attachment, plaintext: string): void {
        if (attachment.socket.readyState !== WebSocket.OPEN) return;
        if (this.hosted === undefined) {
            attachment.socket.send(plaintext);
            return;
        }
        const payload = this.hosted.seal('terminal', attachment.channel, plaintext);
        const envelope: Envelope = {
            header: {
                machineId: this.options.machineId,
                senderId: this.options.machineId,
                recipientId: '*',
                channel: 'terminal',
                streamId: attachment.channel,
                keyVersion: this.options.hostedE2ee!.keyVersion,
                seq: v2EnvelopeSequence(payload),
                at: Date.now(),
            },
            payload,
        };
        attachment.socket.send(JSON.stringify(envelope));
    }

    detach(channel: string, authenticatedDeviceId?: string): void {
        const attachment = this.attachments.get(channel);
        if (attachment === undefined) return;
        if (authenticatedDeviceId !== undefined && attachment.deviceId !== authenticatedDeviceId) {
            throw new Error('terminal: channel belongs to another device');
        }
        attachment.close();
    }


    closeAll(): void {
        for (const channel of [...this.attachments.keys()]) this.detach(channel);
        if (this.graphicsCloseTimer !== undefined) clearTimeout(this.graphicsCloseTimer);
        this.graphicsCloseTimer = undefined;
        this.graphics?.close();
        this.graphics = undefined;
    }
}
