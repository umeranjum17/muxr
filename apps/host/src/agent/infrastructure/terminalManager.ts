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
import { issueWsTicket, terminalSocketUrl, ticketSocketUrl, type Envelope, type TerminalImageFrame, type TerminalScrollStateFrame } from '@muxr/contract';
import { v2EnvelopeSequence } from '@muxr/crypto';
import { HostV2Crypto, type HostedMachineKeys, deviceTableIsObserve, ticketWsCredential } from '../../machine/index.js';

export interface TerminalManagerOptions {
    relayUrl: string;
    machineId: string;
    token?: string;
    resolvePane: (sessionId: string) => Promise<string>;
    focusSession: (sessionId: string) => Promise<void>;
    /** Herdr's own viewport position for a pane. Omitted, the phone is told nothing. */
    readPaneScroll?: (paneId: string) => Promise<{ offsetFromBottom: number; maxOffsetFromBottom: number }>;
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
    initialFrameReceived: boolean;
    scrollStateTimer?: ReturnType<typeof setTimeout>;
    scrollStateReading: boolean;
    scrollStateDirty: boolean;
    scrollOffsetFromBottom: number;
    close: (reason?: string) => void;
}

type TerminalAttachParams = {
    sessionId: string;
    channel: string;
    cols: number;
    rows: number;
    mode?: 'control' | 'observe';
    deviceId?: string;
    takeover?: boolean;
};

const ATTACH_TIMEOUT_MS = 10_000;
const STDERR_TAIL_BYTES = 4 * 1024;
// Herdr's terminal client turns an expired handshake read timeout into an I/O
// framing error, printed with the platform's EAGAIN wording. Before a real
// frame that means the transport never came up -- the pane itself is untouched.
const TRANSIENT_TRANSPORT = /resource temporarily unavailable \(os error 11\)|wouldblock/i;
/** A fling's scrolls arrive in a run; only where it stopped is worth reading. */
const SCROLL_STATE_SETTLE_MS = 90;

/** Herdr's initial screen is a full repaint record, not merely the first line. */
function isInitialScreenRecord(line: string): boolean {
    try {
        const record = JSON.parse(line) as { type?: unknown; full?: unknown; bytes?: unknown };
        return record.type === 'terminal.frame' && record.full === true && typeof record.bytes === 'string';
    } catch {
        return false;
    }
}

export class TerminalManager {
    private readonly attachments = new Map<string, Attachment>();
    /** Attach and detach for one channel must have one owner at a time. */
    private readonly channelQueues = new Map<string, Promise<void>>();
    private readonly controlQueues = new Map<string, Promise<void>>();
    private readonly hosted: HostV2Crypto | undefined;

    constructor(private readonly options: TerminalManagerOptions) {
        this.hosted = options.hostedE2ee === undefined ? undefined : new HostV2Crypto(options.hostedE2ee);
    }

    async attach(params: TerminalAttachParams): Promise<{ paneId: string }> {
        return this.serializeChannel(params.channel, () => this.attachUnlocked(params));
    }

    private async attachUnlocked(params: TerminalAttachParams): Promise<{ paneId: string }> {
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

    private async attachNow(params: TerminalAttachParams, paneId: string): Promise<{ paneId: string }> {
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

        // Selecting a control session must select that pane on the desk;
        // observers must never move it.
        // Do this after authority/takeover checks and before opening resources.
        if (mode === 'control') await this.options.focusSession(params.sessionId);

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
            { stdio: ['pipe', 'pipe', 'pipe'] },
        );
        // A bounded tail is the only way to tell a failed handshake from a pane
        // that really ended; it stays on host stderr and never reaches the phone.
        let stderrTail = '';
        const errors = child.stderr;
        const stderrDrained: Promise<void> = errors === null || errors === undefined
            ? Promise.resolve()
            : new Promise<void>((resolve) => {
                errors.on('data', (chunk: Buffer) => {
                    process.stderr.write(chunk);
                    stderrTail = (stderrTail + chunk.toString('utf8')).slice(-STDERR_TAIL_BYTES);
                });
                errors.once('end', resolve);
                errors.once('close', resolve);
                errors.once('error', () => resolve());
            });
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
            initialFrameReceived: false,
            scrollStateReading: false,
            scrollStateDirty: false,
            scrollOffsetFromBottom: 0,
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
            if (attachment.scrollStateTimer !== undefined) clearTimeout(attachment.scrollStateTimer);
            delete attachment.scrollStateTimer;
            attachment.scrollStateDirty = false;
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
                if (child.exitCode === null) child.stdin?.write(`${JSON.stringify({ type: 'terminal.release' })}\n`);
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
            if (finished) return;
            buffer += chunk.toString('utf8');
            const lines = buffer.split('\n');
            buffer = lines.pop() ?? '';
            for (const line of lines) {
                if (line.trim().length === 0) continue;
                this.sendToPhone(attachment, line);
                if (attachment.scrollOffsetFromBottom > 0) this.scheduleScrollState(attachment);
                // Only a real full repaint is the initial screen. A closed record
                // or a stray diagnostic line must not count, and the ANSI payload
                // itself is forwarded untouched either way.
                if (attachment.initialFrameReceived || !isInitialScreenRecord(line)) continue;
                attachment.initialFrameReceived = true;
                // The pane may already be scrolled back -- a desk reader, or this
                // phone returning to a pane it left scrolled. The control has to
                // be right on the first screen, not only after the first drag.
                this.scheduleScrollState(attachment);
            }
        });

        // Client input is written to the control stream's stdin verbatim.
        // Observe streams are read-only; drop input silently.
        if (!observe) {
            socket.on('message', onInput);
        }

        child.on('exit', (code) => {
            // Classification waits for stderr, but input must stop now: the
            // stream it would be written to is already gone.
            removeInput();
            // stderr can still be draining: classify only once it has, otherwise
            // the very line that identifies a transient failure arrives too late.
            void stderrDrained.then(() => {
                if (finished) return;
                if (!attachment.initialFrameReceived && TRANSIENT_TRANSPORT.test(stderrTail)) {
                    // The pane survived; only this transport died. Retire it
                    // silently so the phone's ordinary socket-close reattach
                    // recovers instead of treating the terminal as ended.
                    process.stderr.write(`terminal: herdr transport failed before the first frame on ${paneId}; retiring for reattach\n`);
                    finish();
                    if (socket.readyState === WebSocket.OPEN) socket.close();
                    return;
                }
                finish(`herdr stream exited (${code ?? 'signal'})`);
            });
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

    /**
     * One `pane.get` per settled burst, never one per scroll frame. A fling
     * arrives as a run of scrolls and only the position it ends at is worth
     * publishing; the trailing read is what makes the last one of the run
     * count. Herdr applies the scroll before it repaints, so the small delay
     * also keeps this read behind the scroll it is reporting on.
     */
    private scheduleScrollState(attachment: Attachment): void {
        if (this.options.readPaneScroll === undefined) return;
        attachment.scrollStateDirty = true;
        if (attachment.scrollStateTimer !== undefined || attachment.scrollStateReading) return;
        attachment.scrollStateTimer = setTimeout(() => {
            delete attachment.scrollStateTimer;
            void this.publishScrollState(attachment);
        }, SCROLL_STATE_SETTLE_MS);
    }

    private async publishScrollState(attachment: Attachment): Promise<void> {
        const read = this.options.readPaneScroll;
        if (read === undefined || attachment.scrollStateReading) return;
        attachment.scrollStateReading = true;
        attachment.scrollStateDirty = false;
        try {
            const scroll = await read(attachment.paneId);
            attachment.scrollOffsetFromBottom = scroll.offsetFromBottom;
            this.sendToPhone(attachment, JSON.stringify({
                type: 'terminal.scroll-state',
                offsetFromBottom: scroll.offsetFromBottom,
                maxOffsetFromBottom: scroll.maxOffsetFromBottom,
            } satisfies TerminalScrollStateFrame));
        } catch {
            // A pane that cannot be read is not a terminal failure. The phone
            // keeps the last position it was told rather than being lied to.
        } finally {
            attachment.scrollStateReading = false;
            if (attachment.scrollStateDirty) this.scheduleScrollState(attachment);
        }
    }

    /**
     * Push an inline image to every live viewer of one pane. Returns how many
     * viewers received it -- zero when no phone is watching, which the CLI
     * reports back to the agent instead of letting it send into the void.
     */
    pushImage(paneId: string, image: { mime: string; bytes: string }): number {
        let viewers = 0;
        for (const attachment of this.attachments.values()) {
            if (attachment.paneId !== paneId) continue;
            this.sendToPhone(attachment, JSON.stringify({
                type: 'terminal.image',
                id: `img_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
                mime: image.mime,
                bytes: image.bytes,
            } satisfies TerminalImageFrame));
            viewers += 1;
        }
        return viewers;
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

    private serializeChannel<T>(channel: string, operation: () => Promise<T>): Promise<T> {
        const previous = this.channelQueues.get(channel) ?? Promise.resolve();
        const run = previous.catch(() => undefined).then(operation);
        const tail = run.then(() => undefined, () => undefined);
        this.channelQueues.set(channel, tail);
        return run.finally(() => {
            if (this.channelQueues.get(channel) === tail) this.channelQueues.delete(channel);
        });
    }

    async detach(channel: string, authenticatedDeviceId?: string): Promise<void> {
        await this.serializeChannel(channel, async () => {
            const attachment = this.attachments.get(channel);
            if (attachment === undefined) return;
            if (authenticatedDeviceId !== undefined && attachment.deviceId !== authenticatedDeviceId) {
                throw new Error('terminal: channel belongs to another device');
            }
            attachment.close();
        });
    }

    closeAll(): void {
        for (const attachment of [...this.attachments.values()]) attachment.close();
    }
}
