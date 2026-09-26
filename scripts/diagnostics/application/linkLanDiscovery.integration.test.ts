/**
 * The LAN route's discovery moves onto @byokit/reach's advertise (step 5).
 *
 * One flow against the real relay start path: with LAN discovery on, the relay
 * publishes the _muxr._tcp service whose txt record carries the dial URL, the
 * machine id and the connection mode, and closing the relay unpublishes it.
 * The phone's locator picker dials that advertised URL, preferring it over a
 * resolved (and possibly virtual-interface) address.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

const published: Array<{ type: string; port: number; name?: string; txt?: Record<string, string> }> = [];
const stops: Array<ReturnType<typeof vi.fn>> = [];

vi.mock('@byokit/reach', () => ({
    advertise: async (options: { type: string; port: number; name?: string; txt?: Record<string, string> }) => {
        published.push(options);
        const stop = vi.fn(async () => undefined);
        stops.push(stop);
        return { stop };
    },
}));

import { startRelay } from '../../../apps/relay/src/relay.js';
import { discoveredRelay } from '../../../apps/mobile/sources/pairing/application/relayLocator.js';

describe('LAN discovery through byokit reach', () => {
    it('publishes the dial URL, machine and mode in the mDNS record, and unpublishes on close', async () => {
        const dataDir = mkdtempSync(join(tmpdir(), 'muxr-lan-mdns-'));
        try {
            const relay = await startRelay({
                port: 0,
                host: '127.0.0.1',
                config: {
                    dataDir,
                    advertiseMdns: true,
                    mdnsConnectionMode: 'lan',
                    mdnsRelayUrl: 'ws://192.168.1.10:8792',
                    mdnsMachineId: 'machine-lan-test',
                    mdnsName: 'Desk',
                },
            });
            try {
                expect(published).toEqual([{
                    type: 'muxr',
                    port: 8792,
                    name: 'Desk',
                    txt: { v: '2', machine: 'machine-lan-test', relay: 'ws://192.168.1.10:8792', mode: 'lan' },
                }]);
            } finally {
                await relay.close();
            }
            expect(stops[0]).toHaveBeenCalled();
        } finally {
            rmSync(dataDir, { recursive: true, force: true });
        }
    });

    it('the phone dials the advertised LAN URL only', () => {
        const service = {
            name: 'Desk',
            addresses: ['172.17.0.1'],
            port: 8792,
            txt: { machine: 'machine-lan-test', relay: 'ws://192.168.1.10:8792', mode: 'lan' },
        };
        expect(discoveredRelay(service)?.relayUrl).toBe('ws://192.168.1.10:8792');
        // No advertised URL, no locator: resolved addresses never authorise a dial.
        expect(discoveredRelay({ ...service, txt: { machine: 'machine-lan-test', mode: 'lan' } })).toBeUndefined();
        // A public advertised URL is not a LAN locator.
        expect(discoveredRelay({ ...service, txt: { machine: 'machine-lan-test', relay: 'wss://desk.ts.net', mode: 'lan' } })).toBeUndefined();
    });
});
