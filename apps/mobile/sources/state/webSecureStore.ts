const DB_NAME = 'muxr-secure';
const STORE_NAME = 'wrapped';
const WRAP_KEY = 'device-wrap-key';
const ITEM_PREFIX = 'item:';

function requireWebCrypto(): void {
    if (!globalThis.isSecureContext || globalThis.crypto?.subtle === undefined || globalThis.indexedDB === undefined) {
        throw new Error('Browser pairing requires HTTPS and WebCrypto');
    }
}

function openDatabase(): Promise<IDBDatabase> {
    requireWebCrypto();
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, 1);
        request.onupgradeneeded = () => request.result.createObjectStore(STORE_NAME);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error ?? new Error('Cannot open browser secure store'));
    });
}

async function transact<T>(mode: IDBTransactionMode, operation: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
    const database = await openDatabase();
    return new Promise((resolve, reject) => {
        const transaction = database.transaction(STORE_NAME, mode);
        const request = operation(transaction.objectStore(STORE_NAME));
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error ?? new Error('Browser secure store failed'));
        transaction.oncomplete = () => database.close();
        transaction.onerror = () => reject(transaction.error ?? new Error('Browser secure store transaction failed'));
    });
}

async function wrapKey(): Promise<CryptoKey> {
    const stored = await transact<CryptoKey | undefined>('readonly', (store) => store.get(WRAP_KEY));
    if (stored !== undefined) return stored;
    const created = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    await transact('readwrite', (store) => store.put(created, WRAP_KEY));
    return created;
}

const bytes = (value: string): ArrayBuffer => new TextEncoder().encode(value).buffer as ArrayBuffer;

export async function getWebSecret(name: string): Promise<string | null> {
    const record = await transact<{ iv: Uint8Array; ciphertext: ArrayBuffer } | undefined>('readonly', (store) => store.get(`${ITEM_PREFIX}${name}`));
    if (record === undefined) return null;
    const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: record.iv as Uint8Array<ArrayBuffer> }, await wrapKey(), record.ciphertext);
    return new TextDecoder().decode(plaintext);
}

export async function setWebSecret(name: string, value: string): Promise<void> {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await wrapKey(), bytes(value));
    await transact('readwrite', (store) => store.put({ iv, ciphertext }, `${ITEM_PREFIX}${name}`));
}

export async function deleteWebSecret(name: string): Promise<void> {
    await transact('readwrite', (store) => store.delete(`${ITEM_PREFIX}${name}`));
}
