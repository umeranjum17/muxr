import type { IncomingMessage } from 'node:http';
import { isLoopbackAddress } from '../domain/loopback.js';
import {
    identityFromTicket,
    loopbackPeerIdentity,
    parseSubscribedMachineIds,
    type PeerIdentity,
    type Ticket,
} from '../domain/peerIdentity.js';

export interface AuthInput {
    req: IncomingMessage;
    url: URL;
    authMode: 'permissive' | 'strict';
    remoteAddress: string | undefined;
    consumeTicket: (ticket: string) => Promise<Ticket | undefined>;
}

export function extractBearerToken(req: IncomingMessage): string | undefined {
    const header = req.headers.authorization;
    if (typeof header !== 'string' || !header.startsWith('Bearer ')) return undefined;
    const token = header.slice('Bearer '.length).trim();
    if (token === '') return undefined;
    return token;
}

export async function authenticateWebSocket(input: AuthInput): Promise<PeerIdentity | undefined> {
    const ticketValue = input.url.searchParams.get('ticket')?.trim();
    if (ticketValue !== undefined && ticketValue !== '') {
        const ticket = await input.consumeTicket(ticketValue);
        if (ticket === undefined) return undefined;
        return identityFromTicket(ticket);
    }

    const machineIds = parseSubscribedMachineIds(input.url);
    const role = input.url.searchParams.get('role');
    if (input.authMode !== 'permissive' || !isLoopbackAddress(input.remoteAddress)) return undefined;
    if ((role === 'machine' || role === 'client') && machineIds.length > 0) {
        return loopbackPeerIdentity(role, new Set(machineIds));
    }
    return undefined;
}
