/**
 * Loopback WebSocket admission uses query-string role/machineId.
 * Ticket-capable credentials mint a short-lived WS ticket instead.
 * Registry `machinetok_` values stay on the query-string path used by
 * the local development harness and probe.
 */
export function usesLoopbackWsAuth(token: string | undefined): boolean {
    return token === undefined || token.startsWith('machinetok_');
}

export function ticketWsCredential(token: string | undefined): string | undefined {
    if (usesLoopbackWsAuth(token)) return undefined;
    return token;
}
