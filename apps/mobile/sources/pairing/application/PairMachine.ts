import type { StoredHostedGrant } from './linkPairing';
import { savedSshTarget, getCachedConnectionSettings, saveConnectionSettings } from '@/connection';
import { realtimeMachineSwitchGuard, stopRealtimeSession } from '@/conversation/session';

export type PairMachineCommand = {
    grant: StoredHostedGrant;
    endVoiceIfPinned?: boolean;
};

export type PairMachineResult =
    | { ok: true; credential: string; secretKey: string }
    | { ok: false; reason: 'voice-pinned'; grant: StoredHostedGrant }
    | { ok: false; reason: 'failed'; message?: string };

/** Activate only this computer's route; leaving it keeps its SSH login and pin. */
async function activateGrant(grant: StoredHostedGrant, endVoiceIfPinned: boolean): Promise<PairMachineResult> {
    const guard = realtimeMachineSwitchGuard(grant.machineId);
    if (!guard.allowed && !endVoiceIfPinned) {
        return { ok: false, reason: 'voice-pinned', grant };
    }
    if (!guard.allowed) stopRealtimeSession();
    const settings = getCachedConnectionSettings();
    const ssh = grant.source === 'selfhost' ? await savedSshTarget(grant.machineId) : undefined;
    await saveConnectionSettings({
        ...settings,
        mode: 'hosted',
        relayUrl: grant.relayUrl,
        machineId: grant.machineId,
        token: '',
        selfhost: grant.source === 'selfhost' ? true : undefined,
        ssh,
    });
    return { ok: true, credential: grant.credential, secretKey: grant.deviceKey.secretKey };
}

/** Claim a pairing link and make that Machine the active connection. */
export async function pairMachine(command: PairMachineCommand): Promise<PairMachineResult> {
    try {
        return await activateGrant(command.grant, command.endVoiceIfPinned === true);
    } catch (error) {
        return { ok: false, reason: 'failed', message: error instanceof Error ? error.message : String(error) };
    }
}
