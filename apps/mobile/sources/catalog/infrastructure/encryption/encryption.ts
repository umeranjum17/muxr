import { deriveKey } from "@/encryption/deriveKey";
import { AES256Encryption, Encryptor, Decryptor } from "./encryptor";
import { encodeHex } from "@/encryption/hex";
import { EncryptionCache } from "./encryptionCache";
import { SessionEncryption } from "./sessionEncryption";
import { MachineEncryption } from "./machineEncryption";
import { decodeBase64 } from "@/encryption/base64";
import sodium from '@/encryption/libsodium.lib';
import { decryptBox, encryptBox } from "@/encryption/libsodium";
import { randomUUID } from 'expo-crypto';

const DATA_KEY_WRAP_VERSION = 0;

export class Encryption {

    static async create(masterSecret: Uint8Array) {
        const contentDataKey = await deriveKey(masterSecret, 'muxr content', ['content']);
        const contentKeyPair = sodium.crypto_box_seed_keypair(contentDataKey);
        const anonID = encodeHex((await deriveKey(masterSecret, 'muxr analytics', ['analytics', 'id']))).slice(0, 16).toLowerCase();
        return new Encryption(anonID, contentKeyPair);
    }

    private readonly contentKeyPair: sodium.KeyPair;
    readonly anonID: string;
    readonly contentDataKey: Uint8Array;

    private sessionEncryptions = new Map<string, SessionEncryption>();
    private machineEncryptions = new Map<string, MachineEncryption>();
    private sessionBlobKeys = new Map<string, Uint8Array>();
    private cache: EncryptionCache;

    private constructor(anonID: string, contentKeyPair: sodium.KeyPair) {
        this.anonID = anonID;
        this.contentKeyPair = contentKeyPair;
        this.cache = new EncryptionCache();
        this.contentDataKey = contentKeyPair.publicKey;
    }

    async openEncryption(dataEncryptionKey: Uint8Array): Promise<Encryptor & Decryptor> {
        return new AES256Encryption(dataEncryptionKey);
    }

    async initializeSessions(sessions: Map<string, Uint8Array>): Promise<void> {
        for (const [sessionId, dataKey] of sessions) {
            if (this.sessionEncryptions.has(sessionId)) continue;
            const encryptor = await this.openEncryption(dataKey);
            this.sessionEncryptions.set(sessionId, new SessionEncryption(sessionId, encryptor, this.cache));
            this.sessionBlobKeys.set(sessionId, await deriveKey(dataKey, 'muxr blobs', ['session']));
        }
    }

    getSessionEncryption(sessionId: string): SessionEncryption | null {
        return this.sessionEncryptions.get(sessionId) || null;
    }

    removeSessionEncryption(sessionId: string): void {
        this.sessionEncryptions.delete(sessionId);
        this.sessionBlobKeys.delete(sessionId);
        this.cache.clearSessionCache(sessionId);
    }

    getSessionBlobKey(sessionId: string): Uint8Array | null {
        return this.sessionBlobKeys.get(sessionId) ?? null;
    }

    async initializeMachines(machines: Map<string, Uint8Array>): Promise<void> {
        for (const [machineId, dataKey] of machines) {
            if (this.machineEncryptions.has(machineId)) continue;
            const encryptor = await this.openEncryption(dataKey);
            this.machineEncryptions.set(machineId, new MachineEncryption(machineId, encryptor, this.cache));
        }
    }

    getMachineEncryption(machineId: string): MachineEncryption | null {
        return this.machineEncryptions.get(machineId) || null;
    }

    removeMachineEncryption(machineId: string): void {
        this.machineEncryptions.delete(machineId);
    }

    async decryptEncryptionKey(encrypted: string) {
        try {
            const encryptedKey = decodeBase64(encrypted, 'base64');
            if (encryptedKey[0] !== DATA_KEY_WRAP_VERSION) {
                return null;
            }
            const decrypted = decryptBox(encryptedKey.slice(1), this.contentKeyPair.privateKey);
            if (!decrypted) {
                return null;
            }
            return decrypted;
        } catch (error) {
            console.error('decryptEncryptionKey failed:', error);
            return null;
        }
    }

    async encryptEncryptionKey(key: Uint8Array): Promise<Uint8Array> {
        const encrypted = encryptBox(key, this.contentKeyPair.publicKey);
        const result = new Uint8Array(encrypted.length + 1);
        result[0] = DATA_KEY_WRAP_VERSION;
        result.set(encrypted, 1);
        return result;
    }

    generateId(): string {
        return randomUUID();
    }
}
