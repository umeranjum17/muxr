import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, unlinkSync } from 'node:fs';
import { createServer, type Server, type Socket } from 'node:net';
import type { PeerRequestResult } from '@muxr/contract';
import type { PeerRuntime } from './runtime.js';
import type { StoredPeerRelationship } from './store.js';

const MAX_REQUEST_BYTES = 32 * 1024;
const MUTATION_TTL_MS = 5 * 60_000;

export type PeerBrokerRequest =
    | { method: 'list'; machine?: string }
    | { method: 'read'; machine: string; agent?: string; lines?: number }
    | { method: 'status'; machine: string; agent?: string }
    | { method: 'watch'; machine: string; agent?: string; timeoutMs?: number }
    | { method: 'prompt'; machine: string; agent?: string; text: string };

function cleanAlias(value: unknown): string {
    return typeof value === 'string'
        ? value.replace(/[\u0000-\u001F\u007F<>`{}]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120)
        : '';
}

function aliasKey(value: string): string {
    return value.trim().toLocaleLowerCase();
}

export class PeerBroker {
    private server: Server | undefined;

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

    async close(): Promise<void> {
        const server = this.server;
        this.server = undefined;
        if (server !== undefined) await new Promise<void>((resolve) => server.close(() => resolve()));
        if (existsSync(this.socketPath) && lstatSync(this.socketPath).isSocket()) unlinkSync(this.socketPath);
    }

    async invoke(request: PeerBrokerRequest): Promise<unknown> {
        if (request.method === 'list') {
            const machine = cleanAlias(request.machine);
            const relationships = machine === '' ? this.outbound() : [this.machine(machine)];
            const aliases = relationships.map((entry) => cleanAlias(entry.machineName) || 'Peer computer');
            const counts = new Map<string, number>();
            for (const alias of aliases) counts.set(aliasKey(alias), (counts.get(aliasKey(alias)) ?? 0) + 1);
            return {
                machines: await Promise.all(relationships.map(async (relationship, index) => {
                    try {
                        const listed = await this.remote<'peer.remote.list'>(relationship, 'peer.remote.list', {});
                        return {
                            machine: aliases[index]!,
                            ...(counts.get(aliasKey(aliases[index]!))! > 1 ? { ambiguous: true } : {}),
                            agents: listed.sessions.map(({ agentAlias, ambiguous }) => ({ agent: cleanAlias(agentAlias), ...(ambiguous === true ? { ambiguous: true } : {}) })),
                        };
                    } catch {
                        return { machine: aliases[index]!, unavailable: true, agents: [] };
                    }
                })),
            };
        }

        const relationship = this.machine(cleanAlias(request.machine));
        let listed: PeerRequestResult<'peer.remote.list'>;
        try { listed = await this.remote<'peer.remote.list'>(relationship, 'peer.remote.list', {}); }
        catch { throw new Error('The selected peer computer is unavailable.'); }
        const agent = cleanAlias(request.agent);
        const matches = agent === ''
            ? listed.sessions
            : listed.sessions.filter((entry) => aliasKey(entry.agentAlias) === aliasKey(agent));
        if (matches.length === 0) throw new Error('No allowed agent with that name is available on the selected computer.');
        if (matches.length > 1 || matches[0]!.ambiguous === true) {
            throw new Error('More than one agent on the selected computer has that name. Ask which agent the user means.');
        }
        const target = matches[0]!;
        try {
            if (request.method === 'read') {
                const lines = request.lines === undefined ? undefined : Math.min(Math.max(Math.trunc(request.lines), 1), 500);
                const result = await this.remote<'peer.remote.read'>(relationship, 'peer.remote.read', {
                    sessionId: target.sessionId,
                    ...(lines === undefined ? {} : { lines }),
                });
                return { machine: cleanAlias(result.machineAlias), agent: cleanAlias(result.agentAlias), text: result.text, truncated: result.truncated };
            }
            if (request.method === 'status') {
                const result = await this.remote<'peer.remote.status'>(relationship, 'peer.remote.status', { sessionId: target.sessionId });
                return {
                    machine: cleanAlias(result.machineAlias),
                    agent: cleanAlias(result.agentAlias),
                    status: { agentStatus: result.status.agentStatus, isStreaming: result.status.isStreaming },
                };
            }
            const mutation = { operationId: `voice_${randomUUID()}`, notValidAfter: Date.now() + MUTATION_TTL_MS };
            if (request.method === 'watch') {
                const timeoutMs = request.timeoutMs === undefined ? undefined : Math.min(Math.max(Math.trunc(request.timeoutMs), 1_000), 60 * 60_000);
                const result = await this.remote<'peer.remote.watch'>(relationship, 'peer.remote.watch', {
                    sessionId: target.sessionId,
                    ...(timeoutMs === undefined ? {} : { timeoutMs }),
                    mutation,
                });
                return { machine: cleanAlias(result.machineAlias), agent: cleanAlias(result.agentAlias), watching: result.watching };
            }
            const text = typeof request.text === 'string' ? request.text.trim().slice(0, 20_000) : '';
            if (text === '') throw new Error('No instruction was given.');
            const result = await this.remote<'peer.remote.prompt'>(relationship, 'peer.remote.prompt', {
                sessionId: target.sessionId,
                text,
                mutation,
            });
            return { machine: cleanAlias(result.machineAlias), agent: cleanAlias(result.agentAlias), delivered: result.delivered };
        } catch (error) {
            if (error instanceof Error && /^(No |More than|The selected)/.test(error.message)) throw error;
            throw new Error('The peer request failed on the selected computer.');
        }
    }

    private outbound(): StoredPeerRelationship[] {
        return this.runtime.store.list().peers.flatMap((entry) => {
            const stored = this.runtime.store.relationship(entry.relationshipId);
            return stored?.direction === 'outbound' && stored.state === 'connected' ? [stored] : [];
        });
    }

    private machine(alias: string): StoredPeerRelationship {
        const matches = this.outbound().filter((entry) => aliasKey(cleanAlias(entry.machineName) || 'Peer computer') === aliasKey(alias));
        if (matches.length === 0) throw new Error('No allowed computer with that name is available.');
        if (matches.length > 1) throw new Error('More than one allowed computer has that name. Ask which computer the user means.');
        return matches[0]!;
    }

    private remote<T extends 'peer.remote.list' | 'peer.remote.read' | 'peer.remote.status' | 'peer.remote.watch' | 'peer.remote.prompt'>(
        relationship: StoredPeerRelationship,
        type: T,
        params: Omit<Extract<import('@muxr/contract').PeerClientRequest, { type: T }>['params'], 'relationshipId'>,
    ): Promise<PeerRequestResult<T>> {
        return this.runtime.handle({
            type,
            requestId: `broker-${randomUUID()}`,
            params: { relationshipId: relationship.relationshipId, ...params },
        } as Extract<import('@muxr/contract').PeerClientRequest, { type: T }>, 'voice-broker') as Promise<PeerRequestResult<T>>;
    }

    private accept(socket: Socket): void {
        let input = '';
        const reply = (value: unknown): void => { socket.end(`${JSON.stringify(value)}\n`); };
        socket.setTimeout(65_000, () => socket.destroy());
        socket.on('data', (chunk) => {
            input += chunk.toString('utf8');
            if (Buffer.byteLength(input) > MAX_REQUEST_BYTES) return socket.destroy();
            const newline = input.indexOf('\n');
            if (newline === -1) return;
            socket.removeAllListeners('data');
            void (async () => {
                try {
                    const message = JSON.parse(input.slice(0, newline)) as { id?: unknown; request?: PeerBrokerRequest };
                    const id = typeof message.id === 'string' ? message.id.slice(0, 120) : '';
                    if (id === '' || message.request === undefined) throw new Error('invalid peer broker request');
                    reply({ id, ok: true, data: await this.invoke(message.request) });
                } catch (error) {
                    reply({ ok: false, error: error instanceof Error ? error.message : 'peer broker request failed' });
                }
            })();
        });
    }
}
