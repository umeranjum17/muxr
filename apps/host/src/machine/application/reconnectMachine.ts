import { ticketWsCredential } from '../domain/admission.js';

export type ReconnectMachineCommand = { token?: string };

export type ReconnectMachineResult =
    | { ok: true; admission: 'loopback'; token?: string }
    | { ok: true; admission: 'ticket'; credential: string };

/** Decide how this Machine reconnects to the relay. URL and socket stay in infrastructure. */
export function reconnectMachine(command: ReconnectMachineCommand): ReconnectMachineResult {
    const credential = ticketWsCredential(command.token);
    if (credential === undefined) {
        return command.token === undefined
            ? { ok: true, admission: 'loopback' }
            : { ok: true, admission: 'loopback', token: command.token };
    }
    return { ok: true, admission: 'ticket', credential };
}
