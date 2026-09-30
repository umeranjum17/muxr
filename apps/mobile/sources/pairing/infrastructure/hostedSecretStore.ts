import { Platform } from 'react-native';
import { deleteNativeSecret, getNativeSecret, setNativeSecret } from './nativeSecretStore';
import { deleteWebSecret, getWebSecret, listWebSecretNames, setWebSecret } from './webSecureStore';

export const secretGet = (key: string): Promise<string | null> => Platform.OS === 'web' ? getWebSecret(key) : getNativeSecret(key);
export const secretSet = (key: string, value: string): Promise<void> => Platform.OS === 'web' ? setWebSecret(key, value) : setNativeSecret(key, value);
export const secretDelete = (key: string): Promise<void> => Platform.OS === 'web' ? deleteWebSecret(key) : deleteNativeSecret(key);

const DEVICE_KEY = 'muxr.hosted-e2ee.device.v2';
const PENDING_PAIR_KEY = 'muxr.hosted-e2ee.pending-pair.v1';
const PENDING_LINK_PAIR_KEY = 'muxr.hosted-e2ee.pending-link-pair.v1';

export interface PendingLinkPair {
    scanned: string;
    name: string;
    secretKey: string;
}

export async function readPendingPair(): Promise<PendingLinkPair | undefined> {
    const raw = await secretGet(PENDING_LINK_PAIR_KEY);
    return raw === null ? undefined : JSON.parse(raw) as PendingLinkPair;
}

export function writePendingPair(pending: PendingLinkPair): Promise<void> {
    return secretSet(PENDING_LINK_PAIR_KEY, JSON.stringify(pending));
}

export function deletePendingPair(): Promise<void> {
    return secretDelete(PENDING_LINK_PAIR_KEY);
}

export function clearPairingSecrets(): Promise<void[]> {
    return Promise.all([DEVICE_KEY, PENDING_PAIR_KEY, PENDING_LINK_PAIR_KEY].map(secretDelete));
}

/** Browser commits can outlive an interrupted index write. */
export async function grantSecretNames(): Promise<string[]> {
    if (Platform.OS !== 'web') return [];
    return (await listWebSecretNames()).filter((key) => key.startsWith('muxr.grant.'))
        .map((key) => key.slice('muxr.grant.'.length));
}
