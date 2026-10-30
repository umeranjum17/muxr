import AsyncStorage from '@react-native-async-storage/async-storage';
import { keyPairFrom, keyPair } from '@byokit/pair';
import { encodeBase64, decodeBase64 } from '@/encryption/base64';
import { Platform } from 'react-native';
import type { StoredHostedGrant } from '../application/linkPairing';
import { getNativeSecret, setNativeSecret, deleteNativeSecret } from './nativeSecretStore';

const NOTICE_KEY = 'muxr.notice-key.v1';
// Non-secret retry state survives logout's credential/catalog cleanup. Native refusal belongs to the kit.
const SIGNED_OUT = 'muxr.notice-signed-out.v1';
let provisioning = Promise.resolve<string | undefined>(undefined);

/** A notification identity belongs to this installation, never to the selected computer. */
export async function nativeNoticeSecret(): Promise<string | undefined> {
    if (Platform.OS !== 'ios' || await AsyncStorage.getItem(SIGNED_OUT) !== null) return undefined;
    return (await getNativeSecret(NOTICE_KEY)) ?? undefined;
}

export async function nativeNoticeCleanupPending(): Promise<boolean> {
    return Platform.OS === 'ios' && await AsyncStorage.getItem(SIGNED_OUT) === 'pending';
}

/** Retried at startup/foreground, even when logout left no paired hosts. */
export async function retryNativeNoticeCleanup(): Promise<void> {
    if (await nativeNoticeCleanupPending()) await syncNativeNotices([]);
}

/** Serialized with grant writes; only a fresh pairing may end a declared sign-out. */
export function syncNativeNotices(grants: StoredHostedGrant[], resume = false): Promise<string | undefined> {
    if (Platform.OS !== 'ios') return Promise.resolve(undefined);
    const paired = [...grants];
    provisioning = provisioning.catch(() => undefined).then(async () => {
        const { setNoticeKey, declareSignedOut, setAnswerTargets } = await import('@byokit/push');
        let signedOut = paired.length === 0 ? 'pending' : await AsyncStorage.getItem(SIGNED_OUT);
        if (signedOut === 'pending') {
            // Even a failure in JS retry storage must not bypass the native refusal.
            await AsyncStorage.setItem(SIGNED_OUT, 'pending')
                .catch(() => console.warn('[push] notice cleanup retry storage unavailable'));
            await declareSignedOut();
            await deleteNativeSecret(NOTICE_KEY);
            await AsyncStorage.setItem(SIGNED_OUT, 'done');
            signedOut = 'done';
        }
        if (paired.length === 0 || (signedOut !== null && !resume)) return undefined;
        const targets = paired.flatMap((grant) => {
            if (grant.authority === 'observe' || grant.expiresAt <= Date.now()) return [];
            const relay = new URL(grant.relayUrl);
            relay.protocol = relay.protocol.replace('ws', 'http');
            if (relay.protocol !== 'https:') return [];
            return [{ host: grant.machineId, relay: relay.origin, key: decodeBase64(grant.machineBoxPublicKey, 'base64url') }];
        });
        // New trusted targets must be installed before setNoticeKey ends native refusal.
        await setAnswerTargets(targets);
        let secret = (await getNativeSecret(NOTICE_KEY)) ?? undefined;
        const needsKey = secret === undefined || resume;
        if (secret === undefined) secret = encodeBase64(keyPair().secretKey);
        const keys = keyPairFrom(decodeBase64(secret));
        // Loading grants or moving a relay must not end the kit's durable sign-out refusal.
        if (needsKey) await setNoticeKey(keys.secretKey);
        await setNativeSecret(NOTICE_KEY, secret);
        await AsyncStorage.removeItem(SIGNED_OUT);
        return encodeBase64(keys.publicKey);
    });
    // Older binaries keep generic alerts; logout must finish even when native cleanup must retry.
    return provisioning.catch(() => {
        console.warn('[push] native notice setup/cleanup pending');
        return undefined;
    });
}
