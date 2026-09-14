import { claimHostedPairing, type StoredHostedGrant } from './hostedE2ee';
import { parsePairingString } from '../domain/pairingString';
import { forgetSshCredential, getCachedConnectionSettings, saveConnectionSettings } from '@/connection';
import { realtimeMachineSwitchGuard, stopRealtimeSession } from '@/conversation/session';

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
    const settings = getCachedConnectionSettings();
    if (settings.machineId !== '' && (settings.machineId !== grant.machineId || settings.selfhost !== (grant.source === 'selfhost'))) {
        await forgetSshCredential(settings.machineId);
    }
    await saveConnectionSettings({
        ...settings,
        mode: 'hosted',
        relayUrl: grant.relayUrl,
        machineId: grant.machineId,
        token: '',
        selfhost: grant.source === 'selfhost' ? true : undefined,
        ...(settings.selfhost === true && settings.machineId === grant.machineId ? {} : { ssh: undefined }),
    });
    return { ok: true, credential: grant.credential, secretKey: grant.deviceKey.secretKey };
}

/** Claim a pairing link and make that Machine the active connection. */
export async function pairMachine(command: PairMachineCommand): Promise<PairMachineResult> {
    try {
        let grant = command.grant;
        if (grant === undefined) {
            if (command.url === undefined) return { ok: false, reason: 'failed', message: 'Pairing link missing' };
            const parsed = parsePairingString(command.url);
            if (!parsed.ok) return { ok: false, reason: 'failed', message: parsed.error };
            grant = await claimHostedPairing(parsed.pairing.url);
        }
        return activateGrant(grant, command.endVoiceIfPinned === true);
    } catch (error) {
        return { ok: false, reason: 'failed', message: error instanceof Error ? error.message : String(error) };
    }
}
