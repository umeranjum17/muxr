import { claimHostedPairing, type StoredHostedGrant } from '@/state/hostedE2ee';
import { getCachedConnectionSettings, saveConnectionSettings } from '@/state/connectionSettings';
import { realtimeMachineSwitchGuard, stopRealtimeSession } from '@/realtime/realtimeSessionState';

export type PairMachineCommand = {
    url?: string;
    grant?: StoredHostedGrant;
    endVoiceIfPinned?: boolean;
};

export type PairMachineResult =
    | { ok: true; credential: string; secretKey: string }
    | { ok: false; reason: 'voice-pinned'; grant: StoredHostedGrant }
    | { ok: false; reason: 'failed'; message?: string };

async function activateGrant(grant: StoredHostedGrant, endVoiceIfPinned: boolean): Promise<PairMachineResult> {
    const guard = realtimeMachineSwitchGuard(grant.machineId);
    if (!guard.allowed && !endVoiceIfPinned) {
        return { ok: false, reason: 'voice-pinned', grant };
    }
    if (!guard.allowed) stopRealtimeSession();
    await saveConnectionSettings({
        ...getCachedConnectionSettings(),
        mode: 'hosted',
        relayUrl: grant.relayUrl,
        machineId: grant.machineId,
        token: '',
        selfhost: grant.source === 'selfhost' ? true : undefined,
    });
    return { ok: true, credential: grant.credential, secretKey: grant.deviceKey.secretKey };
}

/** Claim a pairing link and make that Machine the active connection. */
export async function pairMachine(command: PairMachineCommand): Promise<PairMachineResult> {
    try {
        const grant = command.grant ?? (command.url !== undefined ? await claimHostedPairing(command.url) : undefined);
        if (grant === undefined) return { ok: false, reason: 'failed', message: 'Pairing link missing' };
        return activateGrant(grant, command.endVoiceIfPinned === true);
    } catch (error) {
        return { ok: false, reason: 'failed', message: error instanceof Error ? error.message : String(error) };
    }
}
