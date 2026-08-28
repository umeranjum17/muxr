/**
 * Loopback WebSocket admission uses query-string role/machineId.
 * Ticket-capable credentials (hosted/self-host mint or machine credential)
 * mint a short-lived WS ticket instead. Registry `machinetok_` values stay
 * on the query-string path used by the local development harness.
 */
export function usesLoopbackWsAuth(token: string | undefined): boolean {
    return token === undefined || token.startsWith('machinetok_');
}

export function ticketWsCredential(token: string | undefined): string | undefined {
    if (usesLoopbackWsAuth(token)) return undefined;
    return token;
}

export function loopbackMachineSocketUrl(relayUrl: string, machineId: string, token?: string): string {
    const url = `${relayUrl}?role=machine&machineId=${encodeURIComponent(machineId)}`;
    if (token === undefined) return url;
    return `${url}&token=${encodeURIComponent(token)}`;
}
