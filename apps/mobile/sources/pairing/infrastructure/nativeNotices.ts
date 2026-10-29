import { keyPairFrom, keyPair } from '@byokit/pair';
import { encodeBase64, decodeBase64 } from '@/encryption/base64';
import { Platform } from 'react-native';
import type { StoredHostedGrant } from '../application/linkPairing';
import { getNativeSecret, setNativeSecret, deleteNativeSecret } from './nativeSecretStore';

const NOTICE_KEY = 'muxr.notice-key.v1';
let provisioning = Promise.resolve<string | undefined>(undefined);

/** A notification identity belongs to this installation, never to the selected computer. */
export async function nativeNoticeSecret(): Promise<string | undefined> {
    if (Platform.OS !== 'ios') return undefined;
    return (await getNativeSecret(NOTICE_KEY)) ?? undefined;
}

/** Serialized with grant writes: a revoked host must not be restored by an older provision. */
export function syncNativeNotices(grants: StoredHostedGrant[]): Promise<string | undefined> {
    if (Platform.OS !== 'ios') return Promise.resolve(undefined);
    const paired = [...grants];
    provisioning = provisioning.catch(() => undefined).then(async () => {
        const { setNoticeKey, clearNoticeKey, setAnswerTargets } = await import('@byokit/push');
        if (paired.length === 0) {
            await setAnswerTargets([]);
            await clearNoticeKey();
            await deleteNativeSecret(NOTICE_KEY);
            return undefined;
        }
        let secret = await nativeNoticeSecret();
        if (secret === undefined) {
            secret = encodeBase64(keyPair().secretKey);
            await setNativeSecret(NOTICE_KEY, secret);
        }
        const keys = keyPairFrom(decodeBase64(secret));
        await setNoticeKey(keys.secretKey);
        const targets = paired.flatMap((grant) => {
            if (grant.authority === 'observe' || grant.expiresAt <= Date.now()) return [];
            const relay = new URL(grant.relayUrl);
            relay.protocol = relay.protocol.replace('ws', 'http');
            if (relay.protocol !== 'https:') return [];
            return [{ host: grant.machineId, relay: relay.origin, key: decodeBase64(grant.machineBoxPublicKey, 'base64url') }];
        });
        await setAnswerTargets(targets);
        return encodeBase64(keys.publicKey);
    });
    // Native provisioning is optional for an older binary: its generic alerts still work.
    return provisioning.catch(() => undefined);
}
