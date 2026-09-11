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
        let result!: T;
        request.onsuccess = () => { result = request.result; };
        request.onerror = () => reject(request.error ?? new Error('Browser secure store failed'));
        transaction.oncomplete = () => { database.close(); resolve(result); };
        transaction.onerror = () => { database.close(); reject(transaction.error ?? new Error('Browser secure store transaction failed')); };
        transaction.onabort = () => { database.close(); reject(transaction.error ?? new Error('Browser secure store transaction aborted')); };
    });
}

let wrapKeyPending: Promise<CryptoKey> | undefined;

/**
 * Get-or-create the one wrapping key inside a single readwrite transaction.
 * IndexedDB serializes readwrite transactions on a store across every tab and
 * module realm of the origin, so the first writer wins and every later
 * contender reads that persisted key instead of overwriting it with its own.
 * The candidate key is generated up front: awaiting WebCrypto inside the
 * transaction would let it auto-commit between the read and the write.
 */
async function claimWrapKey(candidate: CryptoKey): Promise<CryptoKey> {
    const database = await openDatabase();
    return new Promise((resolve, reject) => {
        const transaction = database.transaction(STORE_NAME, 'readwrite');
        const store = transaction.objectStore(STORE_NAME);
        let winner: CryptoKey | undefined;
        const read = store.get(WRAP_KEY);
        read.onsuccess = () => {
            const stored = read.result as CryptoKey | undefined;
            if (stored !== undefined) {
                winner = stored;
                return;
            }
            // `add`, not `put`: a key that appeared since the read is a
            // constraint error that aborts this transaction rather than a
            // silent overwrite of another tab's secrets.
            const write = store.add(candidate, WRAP_KEY);
            write.onsuccess = () => { winner = candidate; };
        };
        transaction.oncomplete = () => {
            database.close();
            if (winner === undefined) reject(new Error('Browser secure store lost the wrapping key'));
            else resolve(winner);
        };
        transaction.onerror = () => { database.close(); reject(transaction.error ?? new Error('Browser secure store transaction failed')); };
        transaction.onabort = () => { database.close(); reject(transaction.error ?? new Error('Browser secure store transaction aborted')); };
    });
}

async function wrapKey(): Promise<CryptoKey> {
    wrapKeyPending ??= (async () => {
        const stored = await transact<CryptoKey | undefined>('readonly', (store) => store.get(WRAP_KEY));
        if (stored !== undefined) return stored;
        const candidate = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
        return claimWrapKey(candidate);
    })();
    try { return await wrapKeyPending; }
    catch (cause) { wrapKeyPending = undefined; throw cause; }
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

export async function listWebSecretNames(): Promise<string[]> {
    const keys = await transact<IDBValidKey[]>('readonly', (store) => store.getAllKeys());
    return keys.filter((key): key is string => typeof key === 'string' && key.startsWith(ITEM_PREFIX))
        .map((key) => key.slice(ITEM_PREFIX.length));
}

export function resetWebSecureStore(): Promise<void> {
    wrapKeyPending = undefined;
    return new Promise((resolve, reject) => {
        const request = indexedDB.deleteDatabase(DB_NAME);
        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error ?? new Error('Cannot reset browser secure store'));
        request.onblocked = () => reject(new Error('Close other muxr tabs, then reset this browser again.'));
    });
}
