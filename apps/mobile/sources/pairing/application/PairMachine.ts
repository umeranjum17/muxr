import type { StoredHostedGrant } from './linkPairing';
import { forgetSshCredential, getCachedConnectionSettings, saveConnectionSettings, type SshTarget } from '@/connection';
import { realtimeMachineSwitchGuard, stopRealtimeSession } from '@/conversation/session';

export type PairMachineCommand = {
    grant: StoredHostedGrant;
    endVoiceIfPinned?: boolean;
    ssh?: SshTarget;
};

export type PairMachineResult =
    | { ok: true; credential: string; secretKey: string }
    | { ok: false; reason: 'voice-pinned'; grant: StoredHostedGrant }
    | { ok: false; reason: 'failed'; message?: string };

async function activateGrant(grant: StoredHostedGrant, endVoiceIfPinned: boolean, ssh?: SshTarget): Promise<PairMachineResult> {
    const guard = realtimeMachineSwitchGuard(grant.machineId);
    if (!guard.allowed && !endVoiceIfPinned) {
        return { ok: false, reason: 'voice-pinned', grant };
    }
    if (!guard.allowed) stopRealtimeSession();
    const settings = getCachedConnectionSettings();
    const changingSource = settings.selfhost !== (grant.source === 'selfhost');
    if (settings.machineId !== '' && settings.machineId !== grant.machineId) {
        await forgetSshCredential(settings.machineId);
    } else if (changingSource && ssh === undefined && settings.machineId !== '') {
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
        ...(ssh === undefined ? {} : { ssh }),
    });
    return { ok: true, credential: grant.credential, secretKey: grant.deviceKey.secretKey };
}

/** Claim a pairing link and make that Machine the active connection. */
export async function pairMachine(command: PairMachineCommand): Promise<PairMachineResult> {
    try {
        return await activateGrant(command.grant, command.endVoiceIfPinned === true, command.ssh);
    } catch (error) {
        return { ok: false, reason: 'failed', message: error instanceof Error ? error.message : String(error) };
    }
}
