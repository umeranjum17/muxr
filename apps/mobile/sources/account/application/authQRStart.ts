import { getRandomBytes } from 'expo-crypto';
import sodium from '@/encryption/libsodium.lib';
import axios from 'axios';
import { encodeBase64 } from '@/encryption/base64';
import { getServerUrl } from '@/catalog';
import { getMuxrClientId } from '@/catalog';

export interface QRAuthKeyPair {
    publicKey: Uint8Array;
    secretKey: Uint8Array;
}

export function generateAuthKeyPair(): QRAuthKeyPair {
    const secret = getRandomBytes(32);
    const keypair = sodium.crypto_box_seed_keypair(secret);
    return {
        publicKey: keypair.publicKey,
        secretKey: keypair.privateKey,
    };
}

export async function authQRStart(keypair: QRAuthKeyPair): Promise<boolean> {
    try {
        const serverUrl = getServerUrl();
        await axios.post(`${serverUrl}/v1/auth/account/request`, {
            publicKey: encodeBase64(keypair.publicKey),
        }, {
            headers: {
                'X-Muxr-Client': getMuxrClientId(),
            }
        });
        return true;
    } catch {
        console.log('Failed to create authentication request, please try again later.');
        return false;
    }
}