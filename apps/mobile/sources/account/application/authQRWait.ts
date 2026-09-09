import axios from 'axios';
import { decodeBase64, encodeBase64 } from '@/encryption/base64';
import { getServerUrl } from '@/catalog';
import { QRAuthKeyPair } from './authQRStart';
import { decryptBox } from '@/encryption/libsodium';
import { getMuxrClientId } from '@/catalog';

export interface AuthCredentials {
    secret: Uint8Array;
    token: string;
}

export async function authQRWait(keypair: QRAuthKeyPair, onProgress?: (dots: number) => void, shouldCancel?: () => boolean): Promise<AuthCredentials | null> {
    let dots = 0;
    const serverUrl = getServerUrl();

    while (true) {
        if (shouldCancel?.()) return null;

        try {
            const response = await axios.post(`${serverUrl}/v1/auth/account/request`, {
                publicKey: encodeBase64(keypair.publicKey),
            }, {
                headers: {
                    'X-Muxr-Client': getMuxrClientId(),
                }
            });

            if (response.data.state === 'authorized') {
                const token = response.data.token as string;
                const encryptedResponse = decodeBase64(response.data.response);
                const decrypted = decryptBox(encryptedResponse, keypair.secretKey);
                if (!decrypted) {
                    console.log('\n\nFailed to decrypt response. Please try again.');
                    return null;
                }
                console.log('\n\n✓ Authentication successful\n');
                return { secret: decrypted, token };
            }
        } catch {
            console.log('\n\nFailed to check authentication status. Please try again.');
            return null;
        }

        onProgress?.(dots);
        dots++;
        await new Promise(resolve => setTimeout(resolve, 1000));
    }
}