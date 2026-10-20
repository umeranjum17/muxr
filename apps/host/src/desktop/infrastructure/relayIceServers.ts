import { relayControlUrl, type DesktopIceServer } from '@trymuxr/contract';

/**
 * Asks this host's own relay for TURN/STUN servers with fresh credentials.
 * A relay with none configured (or one too old to know the route) answers
 * 404, which means none: the picture then needs a direct path or the link.
 */
export async function fetchRelayIceServers(relayUrl: string, token: string): Promise<DesktopIceServer[]> {
    const response = await fetch(relayControlUrl(relayUrl, '/v1/selfhost/ice-servers'), {
        method: 'POST',
        headers: { authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(5_000),
    });
    if (response.status === 404) return [];
    const body = await response.json().catch(() => undefined) as { ice_servers?: unknown; error?: unknown } | undefined;
    if (!response.ok) throw new Error(`the relay refused TURN credentials: ${typeof body?.error === 'string' ? body.error : `HTTP ${response.status}`}`);
    if (!Array.isArray(body?.ice_servers)) throw new Error('the relay answered without ice_servers');
    return body.ice_servers.filter((server): server is DesktopIceServer => typeof server === 'object' && server !== null
        && Array.isArray((server as DesktopIceServer).urls) && (server as DesktopIceServer).urls.every((url) => typeof url === 'string'));
}
