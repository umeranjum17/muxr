import { randomBytes, randomUUID } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, unlinkSync } from 'node:fs';
import { createServer, type Server, type Socket } from 'node:net';
import type { PeerRequestResult } from '@muxr/contract';
import type { PeerRuntime } from './runtime.js';
import type { StoredPeerRelationship } from './store.js';

const MAX_REQUEST_BYTES = 32 * 1024;
const MAX_ACK_BYTES = 4 * 1024;
const MUTATION_TTL_MS = 5 * 60_000;
const PLUGIN_ACK_TIMEOUT_MS = 5_000;

export type PeerBrokerRequest =
    | { method: 'list'; machine?: string }
    | { method: 'read'; machine: string; agent?: string; lines?: number }
    | { method: 'status'; machine: string; agent?: string }
    | { method: 'watch'; machine: string; agent?: string; timeoutMs?: number }
    | { method: 'prompt'; machine: string; agent?: string; text: string };

export interface PeerBrokerAccess {
    socketPath: string;
    capability: string;
}

function cleanAlias(value: unknown): string {
    return typeof value === 'string'
        ? value.replace(/[\u0000-\u001F\u007F<>`{}]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120)
        : '';
}

function aliasKey(value: string): string {
    return value.trim().toLocaleLowerCase();
}

function safeVoiceOutput(value: unknown): string {
    return String(value ?? '')
        .replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, '')
        .replace(/-----BEGIN [^-]{1,40}-----[\s\S]*?-----END [^-]{1,40}-----/g, '[credential redacted]')
        .replace(/\b(Bearer)\s+[A-Za-z0-9._~+/-]{12,}/gi, '$1 [redacted]')
        .replace(/\b(api[_-]?key|token|secret|password)\s*[:=]\s*[^\s,;]+/gi, '$1=[redacted]')
        .replace(/\b(?:pph?_[a-z0-9]+|(?:w\d+[A-Za-z]?):(?:p|t)\d+|(?:machine|device|session|pane|rel|peer)[-_][a-z0-9_-]{6,})\b/gi, '[internal id]')
        .replace(/(^|[\s("'])\/(?:[^\s/]+\/)+[^\s]*/gm, '$1[path hidden]')
        .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, ' ')
        .slice(-8_000);
}

function object(value: unknown, label: string): Record<string, unknown> {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`${label} must be an object`);
    return value as Record<string, unknown>;
}

function only(value: Record<string, unknown>, keys: readonly string[]): void {
    if (Object.keys(value).some((key) => !keys.includes(key))) throw new Error('invalid peer broker request fields');
}

function optionalString(value: unknown, field: string): string | undefined {
    if (value === undefined) return undefined;
    if (typeof value !== 'string') throw new Error(`${field} must be a string`);
    return value;
}

function requiredString(value: unknown, field: string): string {
    if (typeof value !== 'string' || value.trim() === '') throw new Error(`${field} must be a non-empty string`);
    return value;
}

function optionalNumber(value: unknown, field: string): number | undefined {
    if (value === undefined) return undefined;
    if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${field} must be a finite number`);
    return value;
}

/** Closed broker request boundary. Unknown methods and fields fail before dispatch. */
export function parsePeerBrokerRequest(value: unknown): PeerBrokerRequest {
    const request = object(value, 'peer broker request');
    if (typeof request.method !== 'string') throw new Error('peer broker method is required');
    switch (request.method) {
        case 'list':
            only(request, ['method', 'machine']);
            return { method: 'list', ...(request.machine === undefined ? {} : { machine: optionalString(request.machine, 'machine')! }) };
        case 'read':
            only(request, ['method', 'machine', 'agent', 'lines']);
            return { method: 'read', machine: requiredString(request.machine, 'machine'), ...(request.agent === undefined ? {} : { agent: optionalString(request.agent, 'agent')! }), ...(request.lines === undefined ? {} : { lines: optionalNumber(request.lines, 'lines')! }) };
        case 'status':
            only(request, ['method', 'machine', 'agent']);
            return { method: 'status', machine: requiredString(request.machine, 'machine'), ...(request.agent === undefined ? {} : { agent: optionalString(request.agent, 'agent')! }) };
        case 'watch':
            only(request, ['method', 'machine', 'agent', 'timeoutMs']);
            return { method: 'watch', machine: requiredString(request.machine, 'machine'), ...(request.agent === undefined ? {} : { agent: optionalString(request.agent, 'agent')! }), ...(request.timeoutMs === undefined ? {} : { timeoutMs: optionalNumber(request.timeoutMs, 'timeoutMs')! }) };
        case 'prompt':
            only(request, ['method', 'machine', 'agent', 'text']);
            return { method: 'prompt', machine: requiredString(request.machine, 'machine'), ...(request.agent === undefined ? {} : { agent: optionalString(request.agent, 'agent')! }), text: requiredString(request.text, 'text') };
        default:
            throw new Error(`unknown peer broker method '${request.method.slice(0, 80)}'`);
    }
}

type SemanticBrokerRequest = Extract<import('@muxr/contract').PeerClientRequest, { type: 'peer.remote.watch' | 'peer.remote.prompt' }>;

interface CapabilityState {
    sockets: Set<Socket>;
    controllers: Set<AbortController>;
}

export class PeerBroker {
    private server: Server | undefined;
    private readonly capabilities = new Map<string, CapabilityState>();

    constructor(readonly socketPath: string, private readonly runtime: PeerRuntime) {}

    async start(): Promise<void> {
        if (this.server !== undefined) return;
        if (existsSync(this.socketPath)) {
            const info = lstatSync(this.socketPath);
            if (!info.isSocket() || info.isSymbolicLink()) throw new Error('peer broker path is not a socket');
            unlinkSync(this.socketPath);
        }
        const server = createServer((socket) => this.accept(socket));
        this.server = server;
        await new Promise<void>((resolve, reject) => {
            server.once('error', reject);
            server.listen(this.socketPath, () => {
                server.off('error', reject);
                chmodSync(this.socketPath, 0o600);
                resolve();
            });
        });
    }

    issueCapability(): PeerBrokerAccess {
        if (this.server === undefined) throw new Error('peer broker is unavailable');
        const capability = randomBytes(32).toString('base64url');
        this.capabilities.set(capability, { sockets: new Set(), controllers: new Set() });
        return { socketPath: this.socketPath, capability };
    }

    revokeCapability(capability: string): void {
        const state = this.capabilities.get(capability);
        this.capabilities.delete(capability);
        if (state === undefined) return;
        for (const controller of state.controllers) controller.abort();
        for (const socket of state.sockets) socket.destroy();
    }

    async close(): Promise<void> {
        const server = this.server;
        this.server = undefined;
        for (const capability of [...this.capabilities.keys()]) this.revokeCapability(capability);
        if (server !== undefined) await new Promise<void>((resolve) => server.close(() => resolve()));
        if (existsSync(this.socketPath) && lstatSync(this.socketPath).isSocket()) unlinkSync(this.socketPath);
    }

    async invoke(value: unknown, access?: {
        capability: string;
        signal: AbortSignal;
        onSemanticResult?: (request: SemanticBrokerRequest) => void;
    }): Promise<unknown> {
        const request = parsePeerBrokerRequest(value);
        const assertAccess = (): void => {
            if (access !== undefined && (access.signal.aborted || !this.capabilities.has(access.capability))) {
                throw Object.assign(new Error('peer broker capability revoked'), { name: 'AbortError' });
            }
        };
        assertAccess();
        if (request.method === 'list') {
            const machine = cleanAlias(request.machine);
            const relationships = machine === '' ? await this.runtime.outboundRelationships() : [await this.runtime.resolveOutboundMachine(machine)];
            return {
                machines: await Promise.all(relationships.map(async (relationship) => {
                    const alias = relationship.machineAlias ?? (cleanAlias(relationship.machineName) || 'Peer computer');
                    try {
                        const listed = await this.remote<'peer.remote.list'>(relationship, 'peer.remote.list', {}, access?.signal);
                        return { machine: alias, agents: listed.sessions.map(({ agentAlias }) => ({ agent: cleanAlias(agentAlias) })) };
                    } catch {
                        return { machine: alias, unavailable: true, agents: [] };
                    }
                })),
            };
        }

        const relationship = await this.runtime.resolveOutboundMachine(cleanAlias(request.machine));
        let listed: PeerRequestResult<'peer.remote.list'>;
        try { listed = await this.remote<'peer.remote.list'>(relationship, 'peer.remote.list', {}, access?.signal); }
        catch { throw new Error('The selected peer computer is unavailable.'); }
        const agent = cleanAlias(request.agent);
        const matches = agent === '' ? listed.sessions : listed.sessions.filter((entry) => aliasKey(entry.agentAlias) === aliasKey(agent));
        if (matches.length === 0) throw new Error('No allowed agent with that name is available on the selected computer.');
        if (matches.length > 1) throw new Error('Use one of the qualified agent aliases returned by list machines.');
        const target = matches[0]!;
        try {
            if (request.method === 'read') {
                const lines = request.lines === undefined ? undefined : Math.min(Math.max(Math.trunc(request.lines), 1), 500);
                const result = await this.remote<'peer.remote.read'>(relationship, 'peer.remote.read', {
                    sessionId: target.sessionId,
                    ...(lines === undefined ? {} : { lines }),
                }, access?.signal);
                return { machine: cleanAlias(result.machineAlias), agent: cleanAlias(result.agentAlias), text: safeVoiceOutput(result.text), truncated: result.truncated };
            }
            if (request.method === 'status') {
                const result = await this.remote<'peer.remote.status'>(relationship, 'peer.remote.status', { sessionId: target.sessionId }, access?.signal);
                return { machine: cleanAlias(result.machineAlias), agent: cleanAlias(result.agentAlias), status: { agentStatus: result.status.agentStatus, isStreaming: result.status.isStreaming } };
            }
            assertAccess();
            const mutation = { operationId: `voice_${randomUUID()}`, notValidAfter: Date.now() + MUTATION_TTL_MS };
            if (request.method === 'watch') {
                const timeoutMs = Math.min(Math.max(Math.trunc(request.timeoutMs ?? 30_000), 1_000), 290_000);
                const params = { sessionId: target.sessionId, timeoutMs, mutation };
                const result = await this.remote<'peer.remote.watch'>(relationship, 'peer.remote.watch', params, access?.signal);
                access?.onSemanticResult?.(this.semanticRequest('peer.remote.watch', relationship, params));
                return {
                    machine: cleanAlias(result.machineAlias),
                    agent: cleanAlias(result.agentAlias),
                    settlement: {
                        status: cleanAlias(result.settlement.status) || 'unknown',
                        detail: safeVoiceOutput(result.settlement.detail),
                        ...(result.settlement.timedOut === true ? { timedOut: true } : {}),
                    },
                };
            }
            const text = request.text.trim().slice(0, 20_000);
            assertAccess();
            const params = { sessionId: target.sessionId, text, mutation };
            const result = await this.remote<'peer.remote.prompt'>(relationship, 'peer.remote.prompt', params, access?.signal);
            access?.onSemanticResult?.(this.semanticRequest('peer.remote.prompt', relationship, params));
            return { machine: cleanAlias(result.machineAlias), agent: cleanAlias(result.agentAlias), delivered: result.delivered };
        } catch (error) {
            if (error instanceof Error && (/^(No |Use one|The selected)/.test(error.message)
                || (error as { name?: unknown }).name === 'AbortError'
                || (error as { code?: unknown }).code === 'peer-mutation-unresolved')) throw error;
            throw new Error('The peer request failed on the selected computer.');
        }
    }

    private semanticRequest<T extends 'peer.remote.watch' | 'peer.remote.prompt'>(
        type: T,
        relationship: StoredPeerRelationship,
        params: Omit<Extract<import('@muxr/contract').PeerClientRequest, { type: T }>['params'], 'relationshipId'>,
    ): Extract<SemanticBrokerRequest, { type: T }> {
        return {
            type,
            requestId: `broker-ack-${randomUUID()}`,
            params: { relationshipId: relationship.relationshipId, ...params },
        } as unknown as Extract<SemanticBrokerRequest, { type: T }>;
    }

    private remote<T extends 'peer.remote.list' | 'peer.remote.read' | 'peer.remote.status' | 'peer.remote.watch' | 'peer.remote.prompt'>(
        relationship: StoredPeerRelationship,
        type: T,
        params: Omit<Extract<import('@muxr/contract').PeerClientRequest, { type: T }>['params'], 'relationshipId'>,
        signal?: AbortSignal,
    ): Promise<PeerRequestResult<T>> {
        if (signal?.aborted) return Promise.reject(Object.assign(new Error('peer broker capability revoked'), { name: 'AbortError' }));
        return this.runtime.handle({
            type,
            requestId: `broker-${randomUUID()}`,
            params: { relationshipId: relationship.relationshipId, ...params },
        } as Extract<import('@muxr/contract').PeerClientRequest, { type: T }>, 'voice-broker', signal) as Promise<PeerRequestResult<T>>;
    }

    private accept(socket: Socket): void {
        let input = '';
        let id = '';
        const reply = (value: unknown): void => {
            if (!socket.destroyed) socket.end(`${JSON.stringify({ id, ...object(value, 'peer broker response') })}\n`);
        };
        socket.setTimeout(5_000, () => socket.destroy());
        socket.on('data', (chunk) => {
            input += chunk.toString('utf8');
            if (Buffer.byteLength(input) > MAX_REQUEST_BYTES) return socket.destroy();
            const newline = input.indexOf('\n');
            if (newline === -1) return;
            socket.removeAllListeners('data');
            void (async () => {
                try {
                    const message = object(JSON.parse(input.slice(0, newline)), 'peer broker message');
                    only(message, ['id', 'capability', 'request']);
                    id = requiredString(message.id, 'id').slice(0, 120);
                    const capability = requiredString(message.capability, 'capability');
                    const state = this.capabilities.get(capability);
                    if (state === undefined) throw new Error('peer broker capability rejected');
                    const controller = new AbortController();
                    state.sockets.add(socket);
                    state.controllers.add(controller);
                    const cleanup = (): void => {
                        state.sockets.delete(socket);
                        state.controllers.delete(controller);
                    };
                    socket.once('close', () => {
                        if (!controller.signal.aborted) controller.abort();
                        cleanup();
                    });
                    const request = parsePeerBrokerRequest(message.request);
                    const requestTimeout = request.method === 'watch'
                        ? Math.min(Math.max(Math.trunc(request.timeoutMs ?? 30_000), 1_000), 290_000) + 25_000
                        : request.method === 'prompt' ? MUTATION_TTL_MS + 25_000 : 45_000;
                    socket.setTimeout(requestTimeout, () => socket.destroy());
                    try {
                        let semantic: SemanticBrokerRequest | undefined;
                        const data = await this.invoke(request, {
                            capability,
                            signal: controller.signal,
                            onSemanticResult: (value) => { semantic = value; },
                        });
                        if (controller.signal.aborted) return;
                        if (semantic === undefined) reply({ ok: true, data });
                        else await this.awaitPluginAck(socket, id, capability, semantic, data);
                    } finally {
                        cleanup();
                    }
                } catch (error) {
                    reply({ ok: false, error: error instanceof Error ? error.message : 'peer broker request failed' });
                }
            })();
        });
    }

    private awaitPluginAck(
        socket: Socket,
        id: string,
        capability: string,
        request: SemanticBrokerRequest,
        data: unknown,
    ): Promise<void> {
        const ackId = randomBytes(24).toString('base64url');
        return new Promise<void>((resolve, reject) => {
            let input = '';
            let accepted = false;
            const stop = (): void => {
                socket.removeListener('data', onData);
                socket.removeListener('close', onClose);
                socket.setTimeout(0);
            };
            const fail = (error: Error): void => {
                if (accepted) return;
                accepted = true;
                stop();
                socket.destroy();
                reject(error);
            };
            const onClose = (): void => fail(new Error('peer broker plugin closed before acknowledging the result'));
            const onData = (chunk: Buffer): void => {
                input += chunk.toString('utf8');
                if (Buffer.byteLength(input) > MAX_ACK_BYTES) return fail(new Error('peer broker acknowledgement is too large'));
                const newline = input.indexOf('\n');
                if (newline === -1) return;
                try {
                    const message = object(JSON.parse(input.slice(0, newline)), 'peer broker acknowledgement');
                    only(message, ['id', 'capability', 'ack']);
                    if (message.id !== id || message.capability !== capability || message.ack !== ackId
                        || !this.capabilities.has(capability)) throw new Error('peer broker acknowledgement rejected');
                    accepted = true;
                    stop();
                    void this.runtime.acknowledgeSemantic(request).then(() => {
                        if (!socket.destroyed) socket.end();
                        resolve();
                    }, reject);
                } catch (error) {
                    fail(error instanceof Error ? error : new Error('peer broker acknowledgement rejected'));
                }
            };
            socket.on('data', onData);
            socket.once('close', onClose);
            socket.setTimeout(PLUGIN_ACK_TIMEOUT_MS, () => fail(new Error('peer broker acknowledgement timed out')));
            socket.write(`${JSON.stringify({ id, ok: true, data, ackId })}\n`);
        });
    }
}
