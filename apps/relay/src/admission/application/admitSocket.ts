import { isLoopbackAddress } from '../domain/loopback.js';
import {
    identityFromTicket,
    loopbackPeerIdentity,
    parseSubscribedMachineIds,
    type PeerIdentity,
    type Ticket,
} from '../domain/peerIdentity.js';

export type AdmitSocketCommand = {
    ticket?: string;
    role?: string;
    subscribedMachineIds: string[];
    authMode: 'permissive' | 'strict';
    remoteAddress?: string;
};

export type AdmitSocketReason = 'ticket-required' | 'ticket-invalid' | 'local-identity-invalid';

export type AdmitSocketResult =
    | { ok: true; identity: PeerIdentity }
    | { ok: false; reason: AdmitSocketReason };

export interface AdmitSocketPorts {
    consumeTicket: (ticket: string) => Promise<Ticket | undefined>;
}

/** Admit a WebSocket. Tickets carry transport; loopback query-string stays live. Display names never admit. */
export async function admitSocket(
    ports: AdmitSocketPorts,
    command: AdmitSocketCommand,
): Promise<AdmitSocketResult> {
    const ticketValue = command.ticket?.trim();
    if (ticketValue !== undefined && ticketValue !== '') {
        const ticket = await ports.consumeTicket(ticketValue);
        if (ticket === undefined) return { ok: false, reason: 'ticket-invalid' };
        return { ok: true, identity: identityFromTicket(ticket) };
    }

    if (command.authMode !== 'permissive') return { ok: false, reason: 'ticket-required' };
    if (!isLoopbackAddress(command.remoteAddress)) return { ok: false, reason: 'local-identity-invalid' };
    const role = command.role;
    if ((role === 'machine' || role === 'client') && command.subscribedMachineIds.length > 0) {
        return { ok: true, identity: loopbackPeerIdentity(role, new Set(command.subscribedMachineIds)) };
    }
    return { ok: false, reason: 'local-identity-invalid' };
}

export function extractBearerToken(req: { headers: { authorization?: unknown } }): string | undefined {
    const header = req.headers.authorization;
    if (typeof header !== 'string' || !header.startsWith('Bearer ')) return undefined;
    const token = header.slice('Bearer '.length).trim();
    if (token === '') return undefined;
    return token;
}

/** Thin URL adapter used by the relay process. */
export async function admitSocketFromUrl(input: {
    url: URL;
    authMode: 'permissive' | 'strict';
    remoteAddress: string | undefined;
    consumeTicket: (ticket: string) => Promise<Ticket | undefined>;
}): Promise<AdmitSocketResult> {
    const ticket = input.url.searchParams.get('ticket');
    const role = input.url.searchParams.get('role');
    const command: AdmitSocketCommand = {
        subscribedMachineIds: parseSubscribedMachineIds(input.url),
        authMode: input.authMode,
    };
    if (ticket !== null && ticket !== '') command.ticket = ticket;
    if (role !== null) command.role = role;
    if (input.remoteAddress !== undefined) command.remoteAddress = input.remoteAddress;
    return admitSocket({ consumeTicket: input.consumeTicket }, command);
}
