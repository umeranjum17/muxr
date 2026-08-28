import type { PairingState } from '../domain/pairing.js';

export type PairMachineCommand = { publicKey: string };
export type PairMachineResult =
    | { ok: true; state: PairingState }
    | { ok: false; reason: 'invalid-key' | 'too-many-pending' };

export type ApproveMachinePairingCommand = { publicKey: string; sealedResponse: string; accountToken: string };
export type ApproveMachinePairingResult = { ok: true } | { ok: false; reason: 'not-found' };

export interface PairingPort {
    request(publicKey: string): PairingState | undefined;
    approve(publicKey: string, response: string, token: string): boolean;
}

export function pairMachine(
    pairing: PairingPort,
    command: PairMachineCommand,
    keyIsValid: (value: string) => boolean,
): PairMachineResult {
    if (!keyIsValid(command.publicKey)) return { ok: false, reason: 'invalid-key' };
    const state = pairing.request(command.publicKey);
    if (state === undefined) return { ok: false, reason: 'too-many-pending' };
    return { ok: true, state };
}

export function approveMachinePairing(
    pairing: PairingPort,
    command: ApproveMachinePairingCommand,
    keyIsValid: (value: string) => boolean,
): ApproveMachinePairingResult {
    if (!keyIsValid(command.publicKey)) return { ok: false, reason: 'not-found' };
    if (!pairing.approve(command.publicKey, command.sealedResponse, command.accountToken)) {
        return { ok: false, reason: 'not-found' };
    }
    return { ok: true };
}
