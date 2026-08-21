import * as SecureStore from 'expo-secure-store';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Platform } from 'react-native';
import {
    deriveV2Key,
    generateKeyPair,
    newV2ReplayTracker,
    newV2SenderState,
    openPairingCodePayload,
    openV2,
    pairingCodeHash,
    sealV2,
    v2EnvelopeSequence,
    v2ReplayFromSnapshot,
    verifyDeviceGrant,
    type DeviceGrant,
    type KeyPair,
    type SealedDeviceGrant,
    type V2ReplaySnapshot,
    type V2ReplayTracker,
    type V2SenderState,
} from '@muxr/crypto';
import { relayControlUrl } from '@muxr/contract';
import { deleteWebSecret, getWebSecret, setWebSecret } from './webSecureStore';
import { getCachedConnectionSettings, loadConnectionSettingsAsync, saveConnectionSettings } from './connectionSettings';
import { decodeBase64 } from '@/encryption/base64';

const DEVICE_KEY = 'muxr.hosted-e2ee.device.v2';
const GRANTS_KEY = 'muxr.hosted-e2ee.grants.v2';
const REPLAY_KEY = 'muxr.hosted-e2ee.replay.v2';
const PENDING_PAIR_KEY = 'muxr.hosted-e2ee.pending-pair.v1';

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
let grantsCache: Record<string, StoredHostedGrant> | undefined;
let replayCache: Record<string, V2ReplaySnapshot> | undefined;
let replayWrite = Promise.resolve();

const secretGet = (key: string): Promise<string | null> => Platform.OS === 'web' ? getWebSecret(key) : SecureStore.getItemAsync(key);
const secretSet = (key: string, value: string): Promise<void> => Platform.OS === 'web' ? setWebSecret(key, value) : SecureStore.setItemAsync(key, value);
const secretDelete = (key: string): Promise<void> => Platform.OS === 'web' ? deleteWebSecret(key) : SecureStore.deleteItemAsync(key);

export async function getOrCreateHostedDeviceKey(): Promise<KeyPair> {
    if (deviceCache !== undefined) return deviceCache;
    const stored = await secretGet(DEVICE_KEY);
    if (stored !== null) {
        const parsed = JSON.parse(stored) as KeyPair;
        if (typeof parsed.publicKey === 'string' && typeof parsed.secretKey === 'string') {
            await secretSet(DEVICE_KEY, stored);
            deviceCache = parsed;
            return parsed;
        }
    }
    const created = generateKeyPair();
    await secretSet(DEVICE_KEY, JSON.stringify(created));
    deviceCache = created;
    return created;
}

const grantKey = (machineId: string): string => `muxr.grant.${machineId}`;
const GRANTS_INDEX = 'muxr.grants.index';

async function grants(): Promise<Record<string, StoredHostedGrant>> {
    if (grantsCache !== undefined) return grantsCache;
    // One SecureStore value per machine (~2 KB Android value limit), plus an index.
    const indexRaw = await secretGet(GRANTS_INDEX);
    if (indexRaw !== null) {
        let ids: string[] = [];
        try {
            const parsed = JSON.parse(indexRaw) as unknown;
            if (Array.isArray(parsed)) ids = parsed.filter((e): e is string => typeof e === 'string');
        } catch {
            ids = [];
        }
        const entries = await Promise.all(ids.map(async (id) => {
            try {
                const raw = await secretGet(grantKey(id));
                if (raw === null) return undefined;
                const grant = JSON.parse(raw) as StoredHostedGrant;
                return [id, grant] as const;
            } catch {
                return undefined;
            }
        }));
        const live = entries.filter((e) => e !== undefined);
        // Rewrite the index from what actually loaded: corrupt/orphaned entries self-heal.
        if (live.length !== ids.length) {
            await secretSet(GRANTS_INDEX, JSON.stringify(live.map(([id]) => id)));
        }
        grantsCache = Object.fromEntries(live);
        return grantsCache;
    }
    // Legacy single-blob migration: split, store per-machine, build the index.
    const stored = await secretGet(GRANTS_KEY);
    const combined = stored === null ? {} : JSON.parse(stored) as Record<string, StoredHostedGrant>;
    const ids = Object.keys(combined);
    if (ids.length > 0) {
        await Promise.all(ids.map((id) => secretSet(grantKey(id), JSON.stringify(combined[id]))));
        await secretSet(GRANTS_INDEX, JSON.stringify(ids));
        await secretDelete(GRANTS_KEY);
    }
    grantsCache = combined;
    return grantsCache;
}

async function replaySnapshots(): Promise<Record<string, V2ReplaySnapshot>> {
    if (replayCache !== undefined) return replayCache;
    const stored = await AsyncStorage.getItem(REPLAY_KEY);
    replayCache = stored === null ? {} : JSON.parse(stored) as Record<string, V2ReplaySnapshot>;
    return replayCache;
}

async function persistReplay(key: string, snapshot: V2ReplaySnapshot): Promise<void> {
    replayCache ??= {};
    replayCache[key] = snapshot;
    const serialized = JSON.stringify(replayCache);
    replayWrite = replayWrite.then(() => AsyncStorage.setItem(REPLAY_KEY, serialized));
    await replayWrite;
}

export async function loadHostedGrant(machineId: string): Promise<StoredHostedGrant | undefined> {
    await replaySnapshots();
    return (await grants())[machineId];
}

export function getCachedHostedGrant(machineId: string): StoredHostedGrant | undefined {
    return grantsCache?.[machineId];
}

/** Every machine this device is paired to, for the Settings machine picker. */
export async function listPairedGrants(): Promise<StoredHostedGrant[]> {
    return Object.values(await grants());
}

/** Forget one machine without deleting this phone's other pairings. */
export async function removeHostedGrant(machineId: string): Promise<StoredHostedGrant[]> {
    const all = await grants();
    if (all[machineId] === undefined) return Object.values(all);
    delete all[machineId];
    await Promise.all([
        secretDelete(grantKey(machineId)),
        secretSet(GRANTS_INDEX, JSON.stringify(Object.keys(all))),
    ]);
    const snapshots = await replaySnapshots();
    for (const key of Object.keys(snapshots)) {
        if (key.startsWith(`${machineId}\0`)) delete snapshots[key];
    }
    await AsyncStorage.setItem(REPLAY_KEY, JSON.stringify(snapshots));
    return Object.values(all);
}

async function saveHostedGrant(grant: StoredHostedGrant): Promise<void> {
    const all = await grants();
    const existing = all[grant.machineId];
    if (existing !== undefined && grant.keyVersion < existing.keyVersion) throw new Error('pairing grant downgrade rejected');
    all[grant.machineId] = grant;
    await secretSet(grantKey(grant.machineId), JSON.stringify(grant));
    await secretSet(GRANTS_INDEX, JSON.stringify(Object.keys(all)));
}

export async function refreshHostedGrant(
    machineId: string,
    credential = '',
    relayUrl = '',
): Promise<StoredHostedGrant | undefined> {
    const current = await loadHostedGrant(machineId);
    if (current === undefined) return undefined;
    const activeCredential = credential.trim() || current.credential;
    const candidateRelay = relayUrl.trim() || current.relayUrl;
    try {
        const result = await json(relayControlUrl(candidateRelay), `/v1/machines/${encodeURIComponent(machineId)}/grant`, {
            headers: { authorization: `Bearer ${activeCredential}` },
        });
        const sealed = JSON.parse(String(result.grant)) as SealedDeviceGrant;
        const verified = verifyDeviceGrant(sealed, {
            pinnedMachineSigningPublicKey: current.machineSigningPublicKey,
            deviceKey: current.deviceKey,
            deviceId: current.deviceId,
        });
        if (verified.machineId !== machineId || verified.keyVersion < current.keyVersion) throw new Error('machine grant downgrade rejected');
        const next: StoredHostedGrant = {
            ...verified,
            deviceKey: current.deviceKey,
            machineBoxPublicKey: sealed.sender,
            credential: activeCredential,
            // A discovered endpoint becomes durable only after it returns a
            // grant verified by the machine key already pinned on this device.
            relayUrl: candidateRelay,
            ...(current.machineName === undefined ? {} : { machineName: current.machineName }),
            ...(current.source === undefined ? {} : { source: current.source }),
        };
        await saveHostedGrant(next);
        return next;
    } catch {
        // Offline startup may use the last valid grant. Keep the freshly
        // authenticated device credential so a later key refresh can recover.
        const fallback = activeCredential === current.credential
            ? current
            : { ...current, credential: activeCredential };
        if (fallback !== current) await saveHostedGrant(fallback);
        return fallback;
    }
}

/** Restore an active pairing from secure storage; the grant, not discovery or AsyncStorage, owns authority. */
export async function restoreHostedConnection(): Promise<StoredHostedGrant | undefined> {
    const settings = await loadConnectionSettingsAsync();
    if (settings.mode !== 'hosted') return undefined;
    const paired = await listPairedGrants();
    const grant = paired.find((entry) => entry.machineId === settings.machineId)
        ?? (settings.machineId === '' && paired.length === 1 ? paired[0] : undefined);
    if (grant === undefined) return undefined;
    if (settings.machineId !== grant.machineId || settings.relayUrl !== grant.relayUrl
        || settings.selfhost !== (grant.source === 'selfhost' ? true : undefined)) {
        await saveConnectionSettings({
            ...settings,
            relayUrl: grant.relayUrl,
            machineId: grant.machineId,
            selfhost: grant.source === 'selfhost' ? true : undefined,
        });
    }
    return grant;
}

/** Verify a discovered locator with the stored grant before switching the active transport. */
export async function reconnectViaDiscoveredRelay(machineId: string, relayUrl: string): Promise<boolean> {
    const settings = getCachedConnectionSettings();
    if (settings.mode !== 'hosted' || settings.machineId !== machineId || settings.relayUrl === relayUrl) return false;
    const verified = await refreshHostedGrant(machineId, '', relayUrl);
    if (verified?.relayUrl !== relayUrl) return false;
    await saveConnectionSettings({
        ...settings,
        relayUrl,
        selfhost: verified.source === 'selfhost' ? true : undefined,
    });
    return true;
}

async function json(base: string, path: string, options: RequestInit = {}): Promise<Record<string, any>> {
    const controller = options.signal === undefined ? new AbortController() : undefined;
    const timeout = controller === undefined ? undefined : setTimeout(() => controller.abort(), 10_000);
    try {
        const response = await fetch(`${base}${path}`, {
            ...options,
            signal: options.signal ?? controller?.signal,
            headers: { 'content-type': 'application/json', ...options.headers },
        });
        const body = await response.json() as Record<string, any>;
        if (!response.ok) {
            const message = String(body.error ?? `request failed (${response.status})`);
            const friendlyErrors: Record<string, string> = {
                invalid_claim: 'This pairing string is invalid. Create a fresh one on the machine.',
                invalid_pairing_code: 'This pairing code is invalid or was already used. Create a fresh one on the machine.',
                pairing_code_expired: 'This pairing code expired. Create a fresh one on the machine.',
                already_claimed: 'This pairing string was already used. Create a fresh one on the machine.',
                expired: 'This pairing string expired. Create a fresh one on the machine.',
                wrong_device_kind: 'This pairing link is for a different client type. Generate a fresh link from the muxr menu.',
            };
            const friendly = friendlyErrors[message];
            throw new Error(friendly ?? message);
        }
        return body;
    } catch (cause) {
        if (cause instanceof Error && cause.name === 'AbortError') throw new Error('The relay did not respond. Check the network, then run `muxr doctor` on the machine.');
        throw cause;
    } finally {
        if (timeout !== undefined) clearTimeout(timeout);
    }
}

export function hostedPairingDisplayName(url: string): string {
    const paramsStart = url.search(/[?#]/);
    const fragment = new URLSearchParams(paramsStart >= 0 ? url.slice(paramsStart + 1) : '');
    let name = fragment.get('name')?.trim();
    const compact = fragment.get('payload');
    if (!name && compact) {
        try { name = JSON.parse(new TextDecoder().decode(decodeBase64(compact, 'base64url'))).name?.trim(); }
        catch { /* claim reports the precise malformed-link error */ }
    }
    return name && name.length <= 120 ? name : 'this machine';
}

interface PendingHostedPair {
    controlBase: string;
    grantPath: string;
    deviceCredential: string;
    deviceId: string;
    machineId: string;
    machineSigningPublicKey: string;
    relayUrl: string;
    machineName: string;
    source?: 'selfhost';
}

async function completePendingHostedPair(pending: PendingHostedPair, wait: boolean): Promise<StoredHostedGrant | undefined> {
    const keys = await getOrCreateHostedDeviceKey();
    let sealed: SealedDeviceGrant | undefined;
    const deadline = wait ? Date.now() + 5 * 60_000 : Date.now();
    do {
        for (const path of [pending.grantPath, `/v1/machines/${encodeURIComponent(pending.machineId)}/grant`]) {
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 3000);
            try {
                const result = await json(pending.controlBase, path, {
                    headers: { authorization: `Bearer ${pending.deviceCredential}` },
                    signal: controller.signal,
                });
                sealed = JSON.parse(String(result.grant)) as SealedDeviceGrant;
                break;
            } catch (error) {
                if (error instanceof Error && (error.name === 'AbortError' || error instanceof TypeError)) {
                    if (!wait) return undefined;
                    continue;
                }
                if (!(error instanceof Error) || (error.message !== 'grant_not_available' && error.message !== 'not_found')) throw error;
            } finally {
                clearTimeout(timeout);
            }
        }
        if (sealed !== undefined || !wait) break;
        await new Promise((resolve) => setTimeout(resolve, 1500));
    } while (Date.now() < deadline);
    if (sealed === undefined) {
        if (!wait) return undefined;
        throw new Error('the machine did not finish the secure grant; pairing will resume when muxr opens again');
    }
    const verified = verifyDeviceGrant(sealed, {
        pinnedMachineSigningPublicKey: pending.machineSigningPublicKey,
        deviceKey: keys,
        deviceId: pending.deviceId,
    });
    if (verified.machineId !== pending.machineId) throw new Error('pairing machine substitution rejected');
    const stored: StoredHostedGrant = {
        ...verified,
        deviceKey: keys,
        machineBoxPublicKey: sealed.sender,
        credential: pending.deviceCredential,
        relayUrl: pending.relayUrl,
        machineName: pending.machineName,
        ...(pending.source === undefined ? {} : { source: pending.source }),
    };
    await saveHostedGrant(stored);
    await secretDelete(PENDING_PAIR_KEY);
    return stored;
}

/** Resume a claim that survived an app/process restart. */
export async function resumePendingHostedPairing(): Promise<StoredHostedGrant | undefined> {
    const raw = await secretGet(PENDING_PAIR_KEY);
    if (raw === null) return undefined;
    return completePendingHostedPair(JSON.parse(raw) as PendingHostedPair, false);
}

async function resolvePairingCode(value: string): Promise<string> {
    const locator = new URL(value);
    const code = locator.searchParams.get('pair');
    if ((locator.protocol !== 'ws:' && locator.protocol !== 'wss:') || code === null) return value;
    const result = await json(relayControlUrl(value), '/v1/selfhost/pair-code', {
        method: 'POST',
        body: JSON.stringify({ code_hash: pairingCodeHash(code) }),
    });
    if (typeof result.payload !== 'string') throw new Error('pairing code payload is unavailable');
    return `muxr://pair?payload=${openPairingCodePayload(result.payload, code)}`;
}

/** Consume a QR/code claim and store the verified machine grant in the platform secret store. */
export async function claimHostedPairing(url: string): Promise<StoredHostedGrant> {
    url = url.trim();
    if (/^wss?:\/\//i.test(url)) url = await resolvePairingCode(url);
    // Deep-link copy can wrap long browser payloads. URLs contain no meaningful whitespace.
    url = url.replace(/\s+/g, '');
    const isSelfhostLink = url.startsWith('muxr://pair?') || url.startsWith('muxr://pair#');
    const parsed = new URL(url);
    const developmentLoopback = typeof __DEV__ !== 'undefined' && __DEV__
        && parsed.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(parsed.hostname);
    if (parsed.protocol !== 'https:' && !isSelfhostLink && !developmentLoopback) {
        throw new Error('pairing link must use HTTPS');
    }
    // Extract by hand: RN's URL polyfill mishandles non-special schemes, and
    // deep-link routers may drop #-fragments — self-host links use ? instead.
    const paramsStart = url.search(/[?#]/);
    const fragment = new URLSearchParams(paramsStart >= 0 ? url.slice(paramsStart + 1) : '');
    const compact = fragment.get('payload');
    if (compact !== null) {
        let decoded: Record<string, unknown>;
        try { decoded = JSON.parse(new TextDecoder().decode(decodeBase64(compact, 'base64url'))); }
        catch { throw new Error('pairing link payload is invalid'); }
        for (const [key, value] of Object.entries(decoded)) {
            if (typeof value === 'string') fragment.set(key, value);
        }
    }
    if (fragment.get('v') !== '2') throw new Error('unknown pairing link version');
    const rawGeneration = fragment.get('generation');
    const generation = rawGeneration === null ? 1 : Number(rawGeneration);
    if (!Number.isInteger(generation) || generation < 1) throw new Error('pairing link uses an invalid encryption generation');
    const pairId = fragment.get('id');
    const claim = fragment.get('claim');
    const pairSecret = fragment.get('pair');
    const machineId = fragment.get('machine');
    const machineSigningPublicKey = fragment.get('machinePk');
    const selfhostRelayParam = fragment.get('r');
    if (![pairId, claim, pairSecret, machineId, machineSigningPublicKey].every((value) => typeof value === 'string' && value.length > 20)) {
        throw new Error('pairing link is incomplete');
    }
    if (selfhostRelayParam !== null && !/^wss?:\/\/[^/]+/.test(selfhostRelayParam)) {
        throw new Error('pairing link has an invalid relay URL');
    }
    const selfhostRelay = selfhostRelayParam;
    // Self-host links carry the relay in `r`; the control base derives via the canonical helper.
    const controlBase = selfhostRelay !== null ? relayControlUrl(selfhostRelay) : parsed.origin;
    const keys = await getOrCreateHostedDeviceKey();
    const deviceName = Platform.OS === 'ios' ? 'iPhone' : Platform.OS === 'android' ? 'Android phone' : 'Browser';
    const mailbox = sealV2(JSON.stringify({
        devicePublicKey: keys.publicKey,
        machineSigningPublicKey,
        deviceName,
    }), deriveV2Key(pairSecret!, 'client->host'), {
        machineId: machineId!,
        senderId: keys.publicKey,
        recipientId: machineId!,
        channel: 'pairing',
        streamId: pairId!,
        keyVersion: generation,
    }, newV2SenderState());
    const claimPath = selfhostRelay !== null
        ? `/v1/selfhost/pair-sessions/${encodeURIComponent(pairId!)}/claim`
        : `/v1/pair-sessions/${encodeURIComponent(pairId!)}/claim`;
    const issued = await json(controlBase, claimPath, {
        method: 'POST',
        body: JSON.stringify({
            ...(selfhostRelay !== null ? { claim } : { control_claim: claim }),
            device_public_key: keys.publicKey,
            device_name: deviceName,
            device_kind: selfhostRelay !== null && Platform.OS === 'web' ? 'browser' : Platform.OS,
            mailbox,
        }),
    });
    const deviceCredential = selfhostRelay !== null ? issued.device_credential : issued.access_token;
    const deviceId = selfhostRelay !== null ? issued.device_id : issued.device?.id;
    if (typeof deviceCredential !== 'string' || typeof deviceId !== 'string') {
        throw new Error('pairing claim was already consumed; create a fresh QR on the machine');
    }
    const pending: PendingHostedPair = {
        controlBase,
        grantPath: selfhostRelay !== null
            ? `/v1/selfhost/pair-sessions/${encodeURIComponent(pairId!)}/grant`
            : `/v1/pair-sessions/${encodeURIComponent(pairId!)}/grant`,
        deviceCredential,
        deviceId,
        machineId: machineId!,
        machineSigningPublicKey: machineSigningPublicKey!,
        relayUrl: selfhostRelay ?? parsed.origin.replace(/^http/i, 'ws'),
        machineName: hostedPairingDisplayName(url),
        ...(selfhostRelay !== null ? { source: 'selfhost' as const } : {}),
    };
    // Claim is one-shot. Persist its credential and binding before waiting so
    // a process death resumes instead of creating an orphaned paired device.
    await secretSet(PENDING_PAIR_KEY, JSON.stringify(pending));
    const completed = await completePendingHostedPair(pending, true);
    if (completed === undefined) throw new Error('the machine did not finish the secure grant');
    return completed;
}

export class DeviceV2Crypto {
    private readonly senders = new Map<string, V2SenderState>();
    private readonly replays = new Map<string, V2ReplayTracker>();
    private readonly inputKey: string;
    private readonly outputKey: string;

    constructor(readonly grant: StoredHostedGrant) {
        this.inputKey = deriveV2Key(grant.dataKey, 'host->client');
        this.outputKey = deriveV2Key(grant.ingressKey, 'client->host');
    }

    seal(channel: 'session' | 'terminal' | 'attachment' | 'stream', streamId: string, plaintext: string): { payload: string; sequence: number } {
        const stateKey = channel;
        const state = this.senders.get(stateKey) ?? newV2SenderState();
        this.senders.set(stateKey, state);
        const payload = sealV2(plaintext, this.outputKey, {
            machineId: this.grant.machineId,
            senderId: this.grant.deviceId,
            recipientId: this.grant.machineId,
            channel,
            streamId,
            keyVersion: this.grant.keyVersion,
        }, state);
        return { payload, sequence: v2EnvelopeSequence(payload) };
    }

    async open(channel: 'session' | 'terminal' | 'attachment' | 'stream', streamId: string, payload: string, sequence: number): Promise<string> {
        if (this.grant.expiresAt <= Date.now()) throw new Error('hosted e2ee: device grant expired');
        if (sequence !== v2EnvelopeSequence(payload)) throw new Error('hosted e2ee: routing sequence mismatch');
        const replayKey = `${this.grant.machineId}\0${channel}\0${streamId}`;
        const snapshot = replayCache?.[replayKey];
        const replay = this.replays.get(replayKey) ?? (snapshot === undefined ? newV2ReplayTracker() : v2ReplayFromSnapshot(snapshot));
        this.replays.set(replayKey, replay);
        const plaintext = openV2(payload, this.inputKey, {
            machineId: this.grant.machineId,
            senderId: this.grant.machineId,
            recipientId: '*',
            channel,
            streamId,
            keyVersion: this.grant.keyVersion,
        }, replay);
        await persistReplay(replayKey, replay.toSnapshot());
        return plaintext;
    }
}

export async function clearHostedE2ee(): Promise<void> {
    const all = await grants();
    await Promise.all([
        secretDelete(DEVICE_KEY),
        secretDelete(GRANTS_KEY),
        secretDelete(GRANTS_INDEX),
        secretDelete(PENDING_PAIR_KEY),
        ...Object.keys(all).map((id) => secretDelete(grantKey(id))),
        AsyncStorage.removeItem(REPLAY_KEY),
    ]);
    deviceCache = undefined;
    grantsCache = undefined;
    replayCache = undefined;
}
