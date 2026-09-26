import { Platform } from 'react-native';
import { DeviceLink } from '@byokit/link';
import { deriveLinkGrant } from '../infrastructure/linkGrant';
import {
    generateKeyPair,
    type DeviceGrant,
    type KeyPair,
} from '@muxr/crypto';
import {
    b64url,
    claimLinkPairing,
    LinkError,
    LINK_WORDS,
    linkKeyPair,
    linkOfferName,
    unb64url,
    type LinkPairAnswer,
    type LinkPairPending,
} from '../infrastructure/linkPairClient';
import { deleteWebSecret, getWebSecret, listWebSecretNames, setWebSecret } from '../infrastructure/webSecureStore';
import { deleteNativeSecret, getNativeSecret, setNativeSecret } from '../infrastructure/nativeSecretStore';
import { getCachedConnectionSettings, loadConnectionSettingsAsync, saveConnectionSettings } from '@/connection';
import { grantRejectsDowngrade } from '../domain/hostedGrant';
import { restoreConnection } from './restoreConnection';

export { hostedPairingAuthority, hostedPairingDisplayName, hostedPairingDuration, looksLikeLinkOffer, prepareHostedPairingInput } from '../domain/pairingString';

const DEVICE_KEY = 'muxr.hosted-e2ee.device.v2';
const PENDING_PAIR_KEY = 'muxr.hosted-e2ee.pending-pair.v1';
const PENDING_LINK_PAIR_KEY = 'muxr.hosted-e2ee.pending-link-pair.v1';

export interface StoredHostedGrant extends DeviceGrant {
    deviceKey: KeyPair;
    machineBoxPublicKey: string;
    credential: string;
    relayUrl: string;
    /** Human-readable pairing name; never expose the internal machine id as UI copy. */
    machineName?: string;
    /** 'selfhost' when paired against a user-run relay (no account, no control plane). */
    source?: 'selfhost';
}

let deviceCache: KeyPair | undefined;
let devicePending: Promise<KeyPair> | undefined;
let grantsCache: Record<string, StoredHostedGrant> | undefined;

const secretGet = (key: string): Promise<string | null> => Platform.OS === 'web' ? getWebSecret(key) : getNativeSecret(key);
const secretSet = (key: string, value: string): Promise<void> => Platform.OS === 'web' ? setWebSecret(key, value) : setNativeSecret(key, value);
const secretDelete = (key: string): Promise<void> => Platform.OS === 'web' ? deleteWebSecret(key) : deleteNativeSecret(key);

export async function getOrCreateHostedDeviceKey(): Promise<KeyPair> {
    if (deviceCache !== undefined) return deviceCache;
    devicePending ??= (async () => {
        const stored = await secretGet(DEVICE_KEY);
        if (stored !== null) {
            const parsed = JSON.parse(stored) as KeyPair;
            if (typeof parsed.publicKey === 'string' && typeof parsed.secretKey === 'string') {
                deviceCache = parsed;
                return parsed;
            }
        }
        const created = generateKeyPair();
        await secretSet(DEVICE_KEY, JSON.stringify(created));
        deviceCache = created;
        return created;
    })();
    try { return await devicePending; }
    catch (cause) { devicePending = undefined; throw cause; }
}

const grantKey = (machineId: string): string => `muxr.grant.${machineId}`;
const GRANTS_INDEX = 'muxr.grants.index';

async function grants(): Promise<Record<string, StoredHostedGrant>> {
    if (grantsCache !== undefined) return grantsCache;
    // One SecureStore value per machine (~2 KB Android value limit), plus an index.
    let ids: string[] = [];
    const indexRaw = await secretGet(GRANTS_INDEX);
    if (indexRaw !== null) {
        try {
            const parsed = JSON.parse(indexRaw) as unknown;
            if (Array.isArray(parsed)) ids = parsed.filter((entry): entry is string => typeof entry === 'string');
        } catch { ids = []; }
    }
    if (Platform.OS === 'web') {
        // Merge committed grant records on every cold load, including an index
        // that exists but missed the final write before a tab/process died.
        const storedIds = (await listWebSecretNames())
            .filter((key) => key.startsWith('muxr.grant.'))
            .map((key) => key.slice('muxr.grant.'.length));
        ids = [...new Set([...ids, ...storedIds])];
    }
    if (ids.length > 0) {
        const entries = await Promise.all(ids.map(async (id) => {
            try {
                const raw = await secretGet(grantKey(id));
                return raw === null ? undefined : [id, JSON.parse(raw) as StoredHostedGrant] as const;
            } catch { return undefined; }
        }));
        const live = entries.filter((entry) => entry !== undefined);
        await secretSet(GRANTS_INDEX, JSON.stringify(live.map(([id]) => id)));
        grantsCache = Object.fromEntries(live);
        return grantsCache;
    }
    grantsCache = {};
    return grantsCache;
}

export async function loadHostedGrant(machineId: string): Promise<StoredHostedGrant | undefined> {
    return (await grants())[machineId];
}

export function getCachedHostedGrant(machineId: string): StoredHostedGrant | undefined {
    return grantsCache?.[machineId];
}

export function currentDeviceAuthority(): 'control' | 'observe' {
    if (Platform.OS !== 'web') return 'control';
    const connection = getCachedConnectionSettings();
    if (connection.mode === 'local') return 'control';
    return grantsCache?.[connection.machineId]?.authority ?? 'observe';
}

/** Every machine this device is paired to, for the Settings machine picker. */
export async function listPairedGrants(): Promise<StoredHostedGrant[]> {
    return Object.values(await grants());
}

/** Forget one machine without deleting this phone's other pairings. */
export async function removeHostedGrant(machineId: string): Promise<StoredHostedGrant[]> {
    const all = await grants();
    if (all[machineId] === undefined) return Object.values(all);
    const { clearArtifactDownloads } = await import('@/utils/artifactTransfer');
    await clearArtifactDownloads();
    (await import('@/catalog')).clearHomeSnapshot(machineId);
    delete all[machineId];
    await Promise.all([
        secretDelete(grantKey(machineId)),
        secretSet(GRANTS_INDEX, JSON.stringify(Object.keys(all))),
    ]);
    return Object.values(all);
}

async function saveHostedGrant(grant: StoredHostedGrant): Promise<void> {
    const all = await grants();
    const existing = all[grant.machineId];
    if (existing !== undefined && existing.credential === '' && grantRejectsDowngrade(existing.keyVersion, grant.keyVersion)) throw new Error('pairing grant downgrade rejected');
    all[grant.machineId] = grant;
    await secretSet(grantKey(grant.machineId), JSON.stringify(grant));
    await secretSet(GRANTS_INDEX, JSON.stringify(Object.keys(all)));
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
    const grant = deriveLinkGrant(current, relayUrl);
    if (grant === undefined) return false;
    let complete: (connected: boolean) => void = () => undefined;
    const online = new Promise<boolean>((resolve) => { complete = resolve; });
    const link = new DeviceLink(grant, { WebSocket: WebSocket as never, onStatus: (status) => {
        if (status === 'online') complete(true);
        if (status === 'removed' || status === 'refused') complete(false);
    } });
    const timeout = setTimeout(() => complete(false), 5000);
    try {
        if (!await online) return false;
        await saveHostedGrant({ ...current, relayUrl });
        await saveConnectionSettings({ ...settings, relayUrl });
        return true;
    } finally {
        clearTimeout(timeout);
        link.stop();
    }
}

function hostedDeviceName(): string {
    if (Platform.OS === 'ios') return 'iPhone';
    if (Platform.OS === 'android') return 'Android phone';
    return 'Browser';
}

/** Only an in-flight link offer can resume; old relay claims cannot. */
export async function resumePendingHostedPairing(): Promise<StoredHostedGrant | undefined> {
    const pending = await secretGet(PENDING_LINK_PAIR_KEY);
    return pending === null ? undefined : resumePendingLinkPairing();
}

interface PendingLinkPair {
    scanned: string;
    name: string;
    /** base64url; persisted before the first connection so a death mid-pairing resumes instead of re-pairing. */
    secretKey: string;
    startedAt: number;
}

/**
 * Native pairing over the byokit link (migration step 4): scan the computer's
 * link QR, show the two confirmation words while the person at the computer
 * approves, then trade `pair.complete` for the machine details and prove this
 * phone holds its key over the machine's real link before anything is stored.
 * The pending pairing is persisted before the first connection, so a process
 * death resumes it rather than leaving the computer holding an unused grant.
 */
export async function pairOverLink(scanned: string, options: { onWords?: (words: string) => void; tunnelPort?: number } = {}): Promise<StoredHostedGrant> {
    if (Platform.OS === 'web' && !/^https:\/\/[^#]+\/pair#byokit-link:1:/.test(scanned)) {
        throw new Error('Native pairing codes are for phones. Use a fresh browser link from `muxr pair --browser` on the computer.');
    }
    const secretKey = b64url(linkKeyPair().secretKey);
    const pending: PendingLinkPair = { scanned, name: hostedDeviceName(), secretKey, startedAt: Date.now() };
    await secretSet(PENDING_LINK_PAIR_KEY, JSON.stringify(pending));
    return completeLinkPairing(pending, { ...options, mode: 'claim' });
}

/** The pairing machine display name for consent, parsed for display only; the pairing itself re-validates. */
export async function linkPairMachineName(scanned: string): Promise<string | undefined> {
    return linkOfferName(scanned, hostedDeviceName());
}

async function resumePendingLinkPairing(): Promise<StoredHostedGrant | undefined> {
    const raw = await secretGet(PENDING_LINK_PAIR_KEY);
    if (raw === null) return undefined;
    const pending = JSON.parse(raw) as PendingLinkPair;
    if (Date.now() - pending.startedAt > 4 * 60_000) {
        await secretDelete(PENDING_LINK_PAIR_KEY);
        return undefined;
    }
    try {
        return await completeLinkPairing(pending, { mode: 'resume' });
    } catch {
        return undefined;
    }
}

async function completeLinkPairing(pending: PendingLinkPair, options: { onWords?: (words: string) => void; tunnelPort?: number; mode: 'claim' | 'resume' }): Promise<StoredHostedGrant> {
    let stored: StoredHostedGrant | undefined;
    try {
        await claimLinkPairing(pending, { ...options, onProven: async (answer, key) => {
            stored = await storeProvenLinkGrant(answer, key);
        } });
    } catch (cause) {
        const message = cause instanceof LinkError && cause.code in LINK_WORDS
            ? LINK_WORDS[cause.code] : cause instanceof Error ? cause.message : String(cause);
        if (Date.now() - pending.startedAt > 4 * 60_000
            || message === 'Your computer said no to this device.' || message.includes('run out')) {
            await secretDelete(PENDING_LINK_PAIR_KEY);
        }
        throw new Error(message);
    }
    if (stored === undefined) throw new Error('the computer did not prove this pairing');
    await secretDelete(PENDING_LINK_PAIR_KEY);
    return stored;
}

async function storeProvenLinkGrant(answer: LinkPairAnswer, key: { publicKey: Uint8Array; secretKey: Uint8Array }): Promise<StoredHostedGrant> {
    const deviceKey = {
        publicKey: Buffer.from(key.publicKey).toString('base64'),
        secretKey: Buffer.from(key.secretKey).toString('base64'),
    };
    const stored: StoredHostedGrant = {
        machineId: answer.machineId,
        // The link pins the machine by its box key; the old transport's
        // signing key never crosses a link pairing.
        machineSigningPublicKey: '',
        deviceId: answer.deviceId,
        devicePublicKey: deviceKey.publicKey,
        keyVersion: 1,
        expiresAt: answer.expiresAt,
        authority: answer.authority,
        deviceKey,
        // The byokit link is the only transport: link-paired phones hold no
        // relay credential (desktop moves onto the link with the cutover).
        machineBoxPublicKey: Buffer.from(unb64url(answer.machineBoxPublicKey)).toString('base64'),
        credential: '',
        dataKey: '',
        ingressKey: '',
        relayUrl: answer.relayUrl,
        machineName: answer.machineName,
        source: 'selfhost',
    };
    await saveHostedGrant(stored);
    return stored;
}

export async function clearHostedE2ee(): Promise<void> {
    const { clearArtifactDownloads } = await import('@/utils/artifactTransfer');
    await clearArtifactDownloads();
    (await import('@/catalog')).clearHomeSnapshot();
    const all = await grants();
    await Promise.all([
        secretDelete(DEVICE_KEY),
        secretDelete(GRANTS_INDEX),
        secretDelete(PENDING_PAIR_KEY),
        ...Object.keys(all).map((id) => secretDelete(grantKey(id))),
    ]);
    deviceCache = undefined;
    devicePending = undefined;
    grantsCache = undefined;
}
