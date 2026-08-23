import { describe, expect, it, vi } from 'vitest';
import { previewSocketUrl } from './preview.js';
import { terminalSocketUrl } from './terminal.js';
import { realtimeSocketUrl } from './realtimeStream.js';
import { relayControlUrl } from './controlPlaneUrl.js';
import { issueWsTicket, ticketSocketUrl } from './wsTickets.js';

describe('relay-derived control-plane flow', () => {
    it('routes every control family at the HTTP origin, fails closed, and leaves websocket paths intact', async () => {
        const relayUrl = 'ws://10.0.2.2:18787/relay?tenant=emulator#socket';
        const routes = [
            '/v1/device-authorizations',
            '/v1/auth/email/start',
            '/v1/auth/email/verify',
            '/v1/pair-sessions/pair-1/claim',
            '/v1/pair-sessions/pair-1/grant',
            '/v1/machines/machine-1/grant',
            '/v1/machines/machine-1/keys/rotate',
            '/v1/devices',
            '/v1/session',
            '/v1/account/deletion/start',
            '/v1/account/deletion/confirm',
            '/v1/push/notify',
            '/v1/push/subscribe',
            '/v1/push/expo-subscribe',
            '/v1/attachment-download',
        ];
        expect(routes.map((path) => relayControlUrl(relayUrl, path))).toEqual(
            routes.map((path) => `http://10.0.2.2:18787${path}`),
        );
        expect(relayControlUrl('wss://relay.example/relay/?x=1', '/v1/session')).toBe('https://relay.example/v1/session');

        const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ticket: 'ticket-1' }), {
            status: 201,
            headers: { 'content-type': 'application/json' },
        }));
        vi.stubGlobal('fetch', fetchMock);
        await expect(issueWsTicket({
            relayUrl,
            credential: 'credential',
            machineId: 'machine-1',
            role: 'client',
            transport: 'relay',
        })).resolves.toBe('ticket-1');
        expect(fetchMock).toHaveBeenCalledWith('http://10.0.2.2:18787/v1/ws-tickets', expect.objectContaining({
            body: JSON.stringify({ machineSlug: 'machine-1', role: 'client', transport: 'relay' }),
        }));

        for (const invalid of ['not a URL', 'http://10.0.2.2:18787/relay', 'ftp://relay.example/relay']) {
            expect(() => relayControlUrl(invalid, '/v1/session')).toThrow();
        }
        expect(() => relayControlUrl('wss://umers-macbook-air.tail@de54.ts.net/?pair=ZKPCA-JNU4T', '/v1/session'))
            .toThrow('text before “@” is treated as login information');
        expect(() => relayControlUrl(relayUrl, 'v1/session')).toThrow('control path must start with /');
        await expect(issueWsTicket({
            relayUrl: 'http://10.0.2.2:18787/relay',
            credential: 'credential',
            machineId: 'machine-1',
            role: 'client',
            transport: 'relay',
        })).rejects.toThrow('relay URL must use ws:// or wss://');
        expect(fetchMock).toHaveBeenCalledTimes(1);
        vi.unstubAllGlobals();

        const websocketRelay = 'ws://10.0.2.2:18787/relay';
        expect(ticketSocketUrl(websocketRelay, 'a/b', 'relay')).toBe('ws://10.0.2.2:18787/relay?ticket=a%2Fb');
        expect(terminalSocketUrl(websocketRelay, { machineId: 'machine', channel: 'terminal', role: 'client' }))
            .toBe('ws://10.0.2.2:18787/relay/terminal?role=client&machineId=machine&channel=terminal');
        expect(previewSocketUrl(websocketRelay, { machineId: 'machine', channel: 'preview', role: 'client' }))
            .toBe('ws://10.0.2.2:18787/relay/preview?role=client&machineId=machine&channel=preview');
        expect(realtimeSocketUrl(websocketRelay, { machineId: 'machine', channel: 'voice', role: 'client' }))
            .toBe('ws://10.0.2.2:18787/relay/stream?role=client&machineId=machine&channel=voice');

        const slashHeavyRelay = `${websocketRelay}${'/'.repeat(100_000)}`;
        expect(ticketSocketUrl(slashHeavyRelay, 'ticket', 'relay'))
            .toBe(`${websocketRelay}?ticket=ticket`);
    });
});
