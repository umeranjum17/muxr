import { probeDiscoveredRelay } from '../infrastructure/linkGrant';
import { cachedGrant, clearGrants, deleteGrant, loadGrants, storeGrant } from '../infrastructure/grantStore';
import { assertSupportedOffer, pairingDeviceName } from '../infrastructure/pairingPlatform';
import {
    type DeviceGrant,
    type KeyPair,
} from '@trymuxr/crypto';
import {
    claimLinkPairing,
    linkOfferName,
    newPairingSecretKey,
    pairingFailure,
    provenLinkGrant,
} from '../infrastructure/linkPairClient';
import { clearPairingSecrets, deletePendingPair, readPendingPair, writePendingPair, type PendingLinkPair } from '../infrastructure/hostedSecretStore';
import { getCachedConnectionSettings, loadConnectionSettingsAsync, saveConnectionSettings } from '@/connection';
import { restoreConnection } from './restoreConnection';

export { hostedPairingAuthority, hostedPairingDisplayName, hostedPairingDuration, looksLikeLinkOffer, prepareHostedPairingInput } from '../domain/pairingString';

export interface StoredHostedGrant extends DeviceGrant {
    deviceKey: KeyPair;
    machineBoxPublicKey: string;
    credential: string;
    relayUrl: string;
    /** Proven dial address returned by the pairing host. */
    linkUrl?: string;
    /** Human-readable pairing name; never expose the internal machine id as UI copy. */
    machineName?: string;
    /** 'selfhost' when paired against a user-run relay (no account, no control plane). */
    source?: 'selfhost';
}

export async function loadHostedGrant(machineId: string): Promise<StoredHostedGrant | undefined> {
    return (await loadGrants())[machineId];
}

export function getCachedHostedGrant(machineId: string): StoredHostedGrant | undefined {
    return cachedGrant(machineId);
}

/** Every machine this device is paired to, for the Settings machine picker. */
export async function listPairedGrants(): Promise<StoredHostedGrant[]> {
    return Object.values(await loadGrants());
}

/** Forget one machine without deleting this phone's other pairings. */
export async function removeHostedGrant(machineId: string): Promise<StoredHostedGrant[]> {
    if ((await loadGrants())[machineId] === undefined) return listPairedGrants();
    const { clearArtifactDownloads } = await import('@/utils/artifactTransfer');
    await clearArtifactDownloads();
    (await import('@/catalog')).clearHomeSnapshot(machineId);
    return deleteGrant(machineId);
}

/** Restore an active pairing from secure storage; the grant, not discovery or AsyncStorage, owns authority. */
export async function restoreHostedConnection(): Promise<StoredHostedGrant | undefined> {
    const settings = await loadConnectionSettingsAsync();
    const paired = await listPairedGrants();
    const result = restoreConnection(settings, paired);
    if (!result.ok) return undefined;
    if (result.adopt) {
        await saveConnectionSettings({
            ...settings,
            relayUrl: result.grant.relayUrl,
            machineId: result.grant.machineId,
            selfhost: result.grant.source === 'selfhost' ? true : undefined,
        });
    }
    return result.grant;
}

/** A discovered locator becomes durable only after the pinned link key accepts it. */
export async function reconnectViaDiscoveredRelay(machineId: string, relayUrl: string): Promise<boolean> {
    const settings = getCachedConnectionSettings();
    if (settings.mode !== 'hosted' || settings.machineId !== machineId || settings.relayUrl === relayUrl) return false;
    const current = await loadHostedGrant(machineId);
    if (current === undefined) return false;
    if (!await probeDiscoveredRelay(current, relayUrl)) return false;
    await storeGrant({ ...current, relayUrl, linkUrl: undefined });
    await saveConnectionSettings({ ...settings, relayUrl });
    return true;
}

export async function recoverSavedHostedPairing(): Promise<StoredHostedGrant | undefined> {
    const pending = await readPendingPair();
    if (pending === undefined) return undefined;
    await deletePendingPair();
    const grants = await listPairedGrants();
    const grant = grants.find((candidate) => candidate.deviceKey.secretKey.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '') === pending.secretKey);
    if (grant === undefined || !await probeDiscoveredRelay(grant, grant.relayUrl)) return undefined;
    return grant;
}

/**
 * Pair over the byokit link: open the computer's offer, show the two
 * confirmation words while the person at the computer approves, then trade
 * `pair.complete` for the machine details and prove this device holds its key
 * over the machine's real link before anything is stored.
 */
export async function pairOverLink(scanned: string, options: { onWords?: (words: string) => void; tunnelPort?: number } = {}): Promise<StoredHostedGrant> {
    assertSupportedOffer(scanned);
    const secretKey = newPairingSecretKey();
    const pending: PendingLinkPair = { scanned, name: pairingDeviceName(), secretKey };
    await writePendingPair(pending);
    return completeLinkPairing(pending, options);
}

/** The pairing machine display name for consent, parsed for display only; the pairing itself re-validates. */
export async function linkPairMachineName(scanned: string): Promise<string | undefined> {
    return linkOfferName(scanned);
}

async function completeLinkPairing(pending: PendingLinkPair, options: { onWords?: (words: string) => void; tunnelPort?: number }): Promise<StoredHostedGrant> {
    let stored: StoredHostedGrant | undefined;
    try {
        await claimLinkPairing(pending, { ...options, onProven: async (answer, key) => {
            const grant = provenLinkGrant(answer, key);
            await storeGrant(grant);
            stored = grant;
        } });
        if (stored === undefined) throw new Error('the computer did not prove this pairing');
        return stored;
    } catch (cause) {
        if (stored !== undefined) {
            const saved = await loadHostedGrant(stored.machineId);
            const relayUrl = options.tunnelPort === undefined ? saved?.relayUrl : `ws://127.0.0.1:${options.tunnelPort}`;
            if (saved !== undefined && relayUrl !== undefined && await probeDiscoveredRelay(saved, relayUrl)) return saved;
        }
        throw new Error(pairingFailure(cause).message);
    } finally {
        await deletePendingPair();
    }
}

export async function clearHostedE2ee(): Promise<void> {
    const { clearArtifactDownloads } = await import('@/utils/artifactTransfer');
    await clearArtifactDownloads();
    (await import('@/catalog')).clearHomeSnapshot();
    await Promise.all([clearPairingSecrets(), clearGrants()]);
}
