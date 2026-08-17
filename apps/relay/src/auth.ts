import { timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { isLoopbackAddress } from './config.js';

/** Narrow core ticket shape — everything WS auth needs, no persistence bookkeeping. */
export interface Ticket {
    role: 'machine' | 'client';
    machineSlug: string;
    accountId: string;
    deviceId?: string;
    machineCredentialId?: string;
    transport: 'relay' | 'terminal' | 'preview' | 'stream';
    channel?: string;
}

export function secureEqual(expected: string, provided: string): boolean {
    const a = Buffer.from(expected);
    const b = Buffer.from(provided);
    return a.length === b.length && timingSafeEqual(a, b);
}

export function extractBearerToken(req: IncomingMessage): string | undefined {
    const header = req.headers.authorization;
    if (typeof header === 'string' && header.startsWith('Bearer ')) {
        return header.slice('Bearer '.length).trim() || undefined;
    }
    return undefined;
}

export interface LegacyPeerIdentity {
    kind: 'legacy';
    role: 'machine' | 'client';
    machineIds: ReadonlySet<string>;
}

export interface TicketPeerIdentity {
    kind: 'ticket';
    role: 'machine' | 'client';
    machineIds: ReadonlySet<string>;
    accountId: string;
    deviceId?: string;
    machineCredentialId?: string;
    transport: 'relay' | 'terminal' | 'preview' | 'stream';
    channel?: string;
}

export type PeerIdentity = LegacyPeerIdentity | TicketPeerIdentity;

export interface AuthInput {
    req: IncomingMessage;
    url: URL;
    authMode: 'permissive' | 'strict';
    remoteAddress: string | undefined;
    consumeTicket: (ticket: string) => Promise<Ticket | undefined>;
}

/** Parse local-development subscriptions. Hosted/strict peers get scope only from a consumed ticket. */
export function parseSubscribedMachineIds(url: URL): string[] {
    const multi = url.searchParams.get('machineIds');
    if (multi !== null && multi.trim() !== '') {
        return [...new Set(multi.split(',').map((part) => part.trim()).filter((part) => part !== ''))];
    }
    const single = url.searchParams.get('machineId')?.trim();
    return single ? [single] : [];
}

export async function authenticateWebSocket(input: AuthInput): Promise<PeerIdentity | undefined> {
    const ticketValue = input.url.searchParams.get('ticket')?.trim();
    if (ticketValue !== undefined && ticketValue !== '') {
        const ticket = await input.consumeTicket(ticketValue);
        if (ticket === undefined) return undefined;
        return {
            kind: 'ticket',
            role: ticket.role,
            machineIds: new Set([ticket.machineSlug]),
            accountId: ticket.accountId,
            ...(ticket.deviceId === undefined ? {} : { deviceId: ticket.deviceId }),
            ...(ticket.machineCredentialId === undefined ? {} : { machineCredentialId: ticket.machineCredentialId }),
            transport: ticket.transport,
            ...(ticket.channel === undefined ? {} : { channel: ticket.channel }),
        };
    }

    const machineIds = parseSubscribedMachineIds(input.url);
    const role = input.url.searchParams.get('role');
    if (input.authMode !== 'permissive' || !isLoopbackAddress(input.remoteAddress)) return undefined;
    if ((role === 'machine' || role === 'client') && machineIds.length > 0) {
        return { kind: 'legacy', role, machineIds: new Set(machineIds) };
    }
    return undefined;
}

export function extractAccountToken(req: IncomingMessage, _url?: URL): string | undefined {
    return extractBearerToken(req);
}
