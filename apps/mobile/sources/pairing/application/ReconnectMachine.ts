import { reconnectViaDiscoveredRelay } from './hostedE2ee';
import { syncReconnect } from '@/catalog/sync';

export type ReconnectMachineCommand = {
    relays: ReadonlyArray<{ machineId: string; relayUrl: string }>;
};

export type ReconnectMachineResult = { ok: true } | { ok: false };

/** Reconnect the active Machine when a discovered locator matches a stored grant. */
export async function reconnectMachine(command: ReconnectMachineCommand): Promise<ReconnectMachineResult> {
    for (const relay of command.relays) {
        if (await reconnectViaDiscoveredRelay(relay.machineId, relay.relayUrl)) {
            await syncReconnect();
            return { ok: true };
        }
    }
    return { ok: false };
}
