import { relayControlUrl, stripTrailingSlashes } from './controlPlaneUrl.js';

export type WsTransport = 'relay' | 'terminal' | 'preview' | 'stream';

export class WsTicketError extends Error {
    constructor(readonly status: number, message: string) {
        super(message);
    }
}

export async function issueWsTicket(input: {
    relayUrl: string;
    credential: string;
    machineId: string;
    role: 'machine' | 'client';
    transport: WsTransport;
    channel?: string;
}): Promise<string> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    let response: Response;
    try {
        response = await fetch(relayControlUrl(input.relayUrl, '/v1/ws-tickets'), {
            method: 'POST',
            headers: { authorization: `Bearer ${input.credential}`, 'content-type': 'application/json' },
            body: JSON.stringify({
                machineSlug: input.machineId,
                role: input.role,
                transport: input.transport,
                ...(input.channel === undefined ? {} : { channel: input.channel }),
            }),
            signal: controller.signal,
        });
    } finally {
        clearTimeout(timer);
    }
    const body = await response.json() as { ticket?: unknown; error?: unknown };
    if (!response.ok || typeof body.ticket !== 'string') {
        const message = typeof body.error === 'string' ? body.error : `ticket request failed (${response.status})`;
        throw new WsTicketError(response.status, message);
    }
    return body.ticket;
}

export function ticketSocketUrl(relayUrl: string, ticket: string, transport: WsTransport, bridge = false): string {
    const path = transport === 'relay' ? '' : `/${transport}`;
    const query = bridge ? `ticket=${encodeURIComponent(ticket)}&bridge=1` : `ticket=${encodeURIComponent(ticket)}`;
    return `${stripTrailingSlashes(relayUrl)}${path}?${query}`;
}
