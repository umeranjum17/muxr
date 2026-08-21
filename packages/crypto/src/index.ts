/**
 * End-to-end encryption for relay payloads.
 *
 * Lives in a shared package, NOT in the relay, because the relay must never be
 * able to decrypt anything. Only the machine host and the client hold keys.
 *
 * Pure JS (tweetnacl) rather than node:crypto so the identical code runs in the
 * daemon and in React Native. X25519 key agreement + XSalsa20-Poly1305 AEAD via
 * nacl.box, which is authenticated -- a tampered frame fails to open.
 *
 * Production traffic uses the strict v2 envelope and the ed25519/X25519
 * grant helpers below. Local development is deliberately cleartext rather
 * than carrying a second, downgrade-prone encryption protocol.
 */

import nacl from 'tweetnacl';

export interface KeyPair {
    /** base64 */
    publicKey: string;
    /** base64 -- never leaves the device that generated it */
    secretKey: string;
}

// Attachment frames run to megabytes, where a per-byte string concat costs
// seconds on Hermes. Buffer when it exists (node host), chunked otherwise.
const BASE64_CHUNK = 0x8000;

function toBase64(bytes: Uint8Array): string {
    if (typeof Buffer !== 'undefined') return Buffer.from(bytes).toString('base64');
    let binary = '';
    for (let i = 0; i < bytes.length; i += BASE64_CHUNK) {
        binary += String.fromCharCode.apply(null, bytes.subarray(i, i + BASE64_CHUNK) as unknown as number[]);
    }
    return btoa(binary);
}

function fromBase64(value: string): Uint8Array {
    // atob (the web path) throws on '-' and '_': base64url keys must be
    // normalized before decoding or every E2EE frame fails silently on web.
    const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
    if (typeof Buffer !== 'undefined') return new Uint8Array(Buffer.from(normalized, 'base64'));
    const binary = atob(normalized);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return bytes;
}

function encodeUtf8(value: string): Uint8Array {
    return new TextEncoder().encode(value);
}

function decodeUtf8(bytes: Uint8Array): string {
    return new TextDecoder().decode(bytes);
}

export function generateKeyPair(): KeyPair {
    const pair = nacl.box.keyPair();
    return { publicKey: toBase64(pair.publicKey), secretKey: toBase64(pair.secretKey) };
}

const PAIRING_CODE_PREFIX = 'muxr:pair-code:v2:';
const PAIRING_CODE_DOMAIN = encodeUtf8('muxr.pair-code.v2');
export const PAIRING_CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';

export function normalizePairingCode(value: string): string {
    const normalized = value.toUpperCase().replace(/[\s-]/g, '');
    if (normalized.length !== 10 || [...normalized].some((character) => !PAIRING_CODE_ALPHABET.includes(character))) {
        throw new Error('pairing code must contain ten unambiguous letters or numbers');
    }
    return normalized;
}

export function formatPairingCode(value: string): string {
    const normalized = normalizePairingCode(value);
    return `${normalized.slice(0, 5)}-${normalized.slice(5)}`;
}

function pairingCodeKey(value: string): Uint8Array {
    return nacl.hash(concatBytes(PAIRING_CODE_DOMAIN, encodeUtf8(normalizePairingCode(value))))
        .subarray(0, nacl.secretbox.keyLength);
}

/** Hash sent to the relay for lookup; the human code itself never leaves the devices. */
export function pairingCodeHash(value: string): string {
    return toBase64(nacl.hash(concatBytes(PAIRING_CODE_DOMAIN, pairingCodeKey(value))).subarray(0, 32))
        .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Encrypt the full high-entropy pairing payload before the relay stores it. */
export function sealPairingCodePayload(payload: string, code: string): string {
    const nonce = nacl.randomBytes(nacl.secretbox.nonceLength);
    const ciphertext = nacl.secretbox(encodeUtf8(payload), nonce, pairingCodeKey(code));
    return PAIRING_CODE_PREFIX + toBase64(concatBytes(nonce, ciphertext));
}

export function openPairingCodePayload(payload: string, code: string): string {
    if (!payload.startsWith(PAIRING_CODE_PREFIX)) throw new Error('unknown pairing code payload');
    const bytes = fromBase64(payload.slice(PAIRING_CODE_PREFIX.length));
    if (bytes.length <= nacl.secretbox.nonceLength) throw new Error('malformed pairing code payload');
    const opened = nacl.secretbox.open(
        bytes.subarray(nacl.secretbox.nonceLength),
        bytes.subarray(0, nacl.secretbox.nonceLength),
        pairingCodeKey(code),
    );
    if (opened === null) throw new Error('pairing code payload failed authentication');
    return decodeUtf8(opened);
}

/** Per-preview root delivered inside the existing encrypted control channel. */
export function newPreviewKey(): string {
    return toBase64(nacl.randomBytes(nacl.secretbox.keyLength));
}

/** Encrypt one TCP payload; connection ids and close flags remain relay-routable. */
export function sealPreviewPayload(payload: Uint8Array, key: string): Uint8Array {
    const nonce = nacl.randomBytes(nacl.secretbox.nonceLength);
    const ciphertext = nacl.secretbox(payload, nonce, toKeyBytes(key, 'preview key'));
    return concatBytes(nonce, ciphertext);
}

export function openPreviewPayload(payload: Uint8Array, key: string): Uint8Array {
    if (payload.length <= nacl.secretbox.nonceLength) throw new Error('preview payload is malformed');
    const opened = nacl.secretbox.open(
        payload.subarray(nacl.secretbox.nonceLength),
        payload.subarray(0, nacl.secretbox.nonceLength),
        toKeyBytes(key, 'preview key'),
    );
    if (opened === null) throw new Error('preview payload failed authentication');
    return opened;
}

// ===========================================================================
// v2 strict envelope (hosted control plane)
//
// Deterministic nonces (random restart epoch + monotonic u64 sequence), a
// context authenticated by inclusion inside the sealed plaintext, and fail-
// closed open: plaintext, malformed/unknown version, context mismatch, replay,
// tamper, and wrong key all throw. Secretbox is XSalsa20-Poly1305.
//
// Wire form: `e2ee:v2:<base64(version(1) || epoch(16) || seq(8 BE) || box)>`
// The box plaintext is one JSON record: every context field + the payload.
// Opening re-derives the nonce from the envelope prefix, decrypts, then
// cross-checks every embedded context field against the envelope and the
// caller's expected context before touching replay state.
// ===========================================================================

export type V2Channel = 'session' | 'terminal' | 'attachment' | 'stream' | 'pairing' | 'grant';
export type V2Direction = 'host->client' | 'client->host';

const V2_PREFIX = 'e2ee:v2:';
const V2_VERSION = 2;
const V2_EPOCH_BYTES = 16;
const V2_SEQ_BYTES = 8;
const V2_CHANNELS: readonly V2Channel[] = ['session', 'terminal', 'attachment', 'stream', 'pairing', 'grant'];
const V2_KEY_LABEL = 'muxr.v2.key';

/** The context every seal is bound to. The receiver must supply the identical context to open. */
export interface V2Context {
    machineId: string;
    senderId: string;
    recipientId: string;
    channel: V2Channel;
    streamId: string;
    keyVersion: number;
}

/**
 * Sender state: a random epoch opens a fresh nonce space, `seq` is monotonic
 * within it. Persist with `v2SenderToSnapshot`/`v2SenderFromSnapshot` so a
 * restart may continue the same epoch/sequence only when the snapshot is
 * committed atomically before another plaintext uses that counter. Hosted
 * callers instead keep state across reconnect and create a fresh random epoch
 * on process restart, avoiding crash rollback nonce reuse.
 */
export interface V2SenderState {
    /** 16 random bytes, base64. */
    epoch: string;
    /** Next sequence number to use for this epoch. */
    seq: number;
}

export interface V2ReplaySnapshot {
    /** Highest accepted sequence per epoch, capped at maxEpochs. */
    epochs: Array<{ epoch: string; maxSeq: number }>;
}

export interface V2ReplayTracker {
    /**
     * Strict monotonic per epoch: false for any sequence already accepted or
     * below the epoch's high-water mark. Callers invoke this only after the box
     * authenticated, so forged frames never consume tracker state.
     */
    accept(epoch: string, seq: number): boolean;
    /** Bounded snapshot for persistence; restore with `v2ReplayFromSnapshot`. */
    toSnapshot(): V2ReplaySnapshot;
}

function toKeyBytes(key: string | Uint8Array, what: string): Uint8Array {
    const bytes = typeof key === 'string' ? fromBase64(key) : key;
    if (bytes.length !== nacl.secretbox.keyLength) {
        throw new Error(`${what}: key must be ${nacl.secretbox.keyLength} bytes`);
    }
    return bytes;
}

function validateV2Context(ctx: V2Context): void {
    if (ctx === null || typeof ctx !== 'object') throw new Error('v2: context required');
    const { machineId, senderId, recipientId, channel, streamId, keyVersion } = ctx;
    if (typeof machineId !== 'string' || machineId === '') throw new Error('v2: machineId required');
    if (typeof senderId !== 'string' || senderId === '') throw new Error('v2: senderId required');
    if (typeof recipientId !== 'string' || recipientId === '') throw new Error('v2: recipientId required');
    if (!V2_CHANNELS.includes(channel)) throw new Error('v2: unknown channel');
    if (typeof streamId !== 'string' || streamId === '') throw new Error('v2: streamId required');
    if (!Number.isInteger(keyVersion) || keyVersion < 2) throw new Error('v2: key generation must be 2 or newer');
}

function concatBytes(...arrays: Uint8Array[]): Uint8Array {
    const total = arrays.reduce((n, a) => n + a.length, 0);
    const out = new Uint8Array(total);
    let offset = 0;
    for (const a of arrays) {
        out.set(a, offset);
        offset += a.length;
    }
    return out;
}

function writeU64BE(value: number, out: Uint8Array, offset: number): void {
    let v = Math.floor(value);
    for (let i = 7; i >= 0; i -= 1) {
        out[offset + i] = v % 256;
        v = Math.floor(v / 256);
    }
}

function readU64BE(bytes: Uint8Array, offset: number): number {
    let value = 0;
    for (let i = 0; i < V2_SEQ_BYTES; i += 1) {
        value = value * 256 + bytes[offset + i]!;
    }
    return value;
}

function buildV2Nonce(epochB64: string, seq: number): Uint8Array {
    const epoch = fromBase64(epochB64);
    if (epoch.length !== V2_EPOCH_BYTES) throw new Error(`v2: epoch must be ${V2_EPOCH_BYTES} bytes`);
    if (!Number.isSafeInteger(seq) || seq < 0) throw new Error('v2: seq must be a non-negative safe integer');
    const nonce = new Uint8Array(nacl.secretbox.nonceLength);
    nonce.set(epoch, 0);
    writeU64BE(seq, nonce, V2_EPOCH_BYTES);
    return nonce;
}

/**
 * Domain-separated directional key from a 32-byte root (base64 or bytes).
 * Deterministic: both sides derive the same key from the same root+direction.
 * Pairing mailboxes use the pair-secret root with channel 'pairing'.
 */
export function deriveV2Key(root: string | Uint8Array, direction: V2Direction): string {
    const domain = encodeUtf8(`${V2_KEY_LABEL}.${direction}`);
    const digest = nacl.hash(concatBytes(domain, toKeyBytes(root, 'deriveV2Key root')));
    return toBase64(digest.subarray(0, nacl.secretbox.keyLength));
}

/** Fresh sender state: a new random restart epoch at sequence 0. */
export function newV2SenderState(): V2SenderState {
    return { epoch: toBase64(nacl.randomBytes(V2_EPOCH_BYTES)), seq: 0 };
}

/** Copy for persistence; survives JSON.stringify. */
export function v2SenderToSnapshot(state: V2SenderState): V2SenderState {
    return { epoch: state.epoch, seq: state.seq };
}

/** Validate and restore persisted sender state. Fails closed on garbage. */
export function v2SenderFromSnapshot(snapshot: V2SenderState): V2SenderState {
    if (snapshot === null || typeof snapshot !== 'object') throw new Error('v2 sender: snapshot required');
    if (typeof snapshot.epoch !== 'string' || fromBase64(snapshot.epoch).length !== V2_EPOCH_BYTES) {
        throw new Error(`v2 sender: epoch must be ${V2_EPOCH_BYTES} bytes, base64`);
    }
    if (!Number.isSafeInteger(snapshot.seq) || snapshot.seq < 0) {
        throw new Error('v2 sender: seq must be a non-negative safe integer');
    }
    return { epoch: snapshot.epoch, seq: snapshot.seq };
}

export function isV2Envelope(payload: string): boolean {
    return payload.startsWith(V2_PREFIX);
}

/** Authenticated sequence carried in the v2 nonce prefix; callers mirror it into routing headers. */
export function v2EnvelopeSequence(payload: string): number {
    if (!isV2Envelope(payload)) throw new Error('v2 sequence: rejected non-v2 payload');
    const bytes = fromBase64(payload.slice(V2_PREFIX.length));
    if (bytes.length < 1 + V2_EPOCH_BYTES + V2_SEQ_BYTES || bytes[0] !== V2_VERSION) {
        throw new Error('v2 sequence: malformed or unknown envelope');
    }
    const sequence = readU64BE(bytes, 1 + V2_EPOCH_BYTES);
    if (!Number.isSafeInteger(sequence) || sequence < 0) throw new Error('v2 sequence: malformed sequence');
    return sequence;
}

/**
 * Seal `plaintext` into a v2 envelope, advancing `state.seq` on success.
 * Nonce = epoch(16) || seq(u64 BE): deterministic, safe across reconnect and
 * restart because hosted callers retain seq across reconnect and use a fresh
 * random epoch on process restart.
 */
export function sealV2(plaintext: string, key: string | Uint8Array, ctx: V2Context, state: V2SenderState): string {
    validateV2Context(ctx);
    const keyBytes = toKeyBytes(key, 'sealV2 key');
    const seq = state.seq;
    const nonce = buildV2Nonce(state.epoch, seq);
    const inner = JSON.stringify({
        v: V2_VERSION,
        m: ctx.machineId,
        s: ctx.senderId,
        r: ctx.recipientId,
        c: ctx.channel,
        st: ctx.streamId,
        kv: ctx.keyVersion,
        e: state.epoch,
        q: seq,
        p: plaintext,
    });
    const ciphertext = nacl.secretbox(encodeUtf8(inner), nonce, keyBytes);
    state.seq = seq + 1;
    return V2_PREFIX + toBase64(concatBytes(Uint8Array.of(V2_VERSION), nonce, ciphertext));
}

/**
 * Open a v2 envelope. Fails closed: throws on cleartext/legacy payloads,
 * malformed or unknown version, authentication failure (tamper or wrong key),
 * any embedded context field not matching the envelope or `expected`, and
 * replay. `replay.accept` runs only after the box authenticated.
 */
export function openV2(envelope: string, key: string | Uint8Array, expected: V2Context, replay: V2ReplayTracker): string {
    validateV2Context(expected);
    if (!isV2Envelope(envelope)) {
        throw new Error('v2 open: rejected non-v2 payload (strict mode fails closed on cleartext and legacy frames)');
    }
    const bytes = fromBase64(envelope.slice(V2_PREFIX.length));
    if (bytes.length < 1 + V2_EPOCH_BYTES + V2_SEQ_BYTES) throw new Error('v2 open: malformed envelope');
    const version = bytes[0]!;
    if (version !== V2_VERSION) throw new Error(`v2 open: unknown version ${version}`);
    const epoch = toBase64(bytes.subarray(1, 1 + V2_EPOCH_BYTES));
    const seq = readU64BE(bytes, 1 + V2_EPOCH_BYTES);
    if (!Number.isSafeInteger(seq) || seq < 0) throw new Error('v2 open: malformed sequence');
    const nonce = bytes.subarray(1, 1 + V2_EPOCH_BYTES + V2_SEQ_BYTES);
    const ciphertext = bytes.subarray(1 + V2_EPOCH_BYTES + V2_SEQ_BYTES);
    const opened = nacl.secretbox.open(ciphertext, nonce, toKeyBytes(key, 'openV2 key'));
    if (opened === null) throw new Error('v2 open: authentication failed (tamper or wrong key)');
    let inner: Record<string, unknown>;
    try {
        inner = JSON.parse(decodeUtf8(opened)) as Record<string, unknown>;
    } catch {
        throw new Error('v2 open: malformed sealed plaintext');
    }
    if (
        inner['v'] !== V2_VERSION
        || inner['m'] !== expected.machineId
        || inner['s'] !== expected.senderId
        || inner['r'] !== expected.recipientId
        || inner['c'] !== expected.channel
        || inner['st'] !== expected.streamId
        || inner['kv'] !== expected.keyVersion
        || inner['e'] !== epoch
        || inner['q'] !== seq
    ) {
        throw new Error('v2 open: context mismatch');
    }
    const payload = inner['p'];
    if (typeof payload !== 'string') throw new Error('v2 open: context mismatch');
    if (!replay.accept(epoch, seq)) throw new Error('v2 open: replay rejected');
    return payload;
}

/**
 * Bounded replay tracker: the high-water sequence per epoch. It fails closed
 * when full rather than forgetting an old epoch (which would make captured
 * frames replayable). Restore a persisted snapshot with `v2ReplayFromSnapshot`.
 */
export function newV2ReplayTracker(maxEpochs = 4096): V2ReplayTracker {
    if (!Number.isInteger(maxEpochs) || maxEpochs < 1) throw new Error('v2 replay: maxEpochs must be a positive integer');
    const seen = new Map<string, number>();
    return {
        accept(epoch, seq) {
            const max = seen.get(epoch);
            if (max !== undefined && seq <= max) return false;
            if (max === undefined && seen.size >= maxEpochs) return false;
            seen.set(epoch, seq);
            return true;
        },
        toSnapshot() {
            return { epochs: [...seen.entries()].map(([epoch, maxSeq]) => ({ epoch, maxSeq })) };
        },
    };
}

/** Restore a persisted replay snapshot. Invalid entries throw (fail closed). */
export function v2ReplayFromSnapshot(snapshot: V2ReplaySnapshot, maxEpochs = 4096): V2ReplayTracker {
    if (snapshot === null || typeof snapshot !== 'object' || !Array.isArray(snapshot.epochs)) {
        throw new Error('v2 replay: snapshot required');
    }
    for (const entry of snapshot.epochs) {
        if (entry === null || typeof entry !== 'object' || typeof entry.epoch !== 'string' || fromBase64(entry.epoch).length !== V2_EPOCH_BYTES) {
            throw new Error('v2 replay: malformed snapshot entry');
        }
        if (!Number.isSafeInteger(entry.maxSeq) || entry.maxSeq < 0) throw new Error('v2 replay: malformed snapshot maxSeq');
    }
    const tracker = newV2ReplayTracker(maxEpochs);
    if (snapshot.epochs.length > maxEpochs) throw new Error('v2 replay: snapshot exceeds fail-closed epoch limit');
    for (const entry of snapshot.epochs) tracker.accept(entry.epoch, entry.maxSeq);
    return tracker;
}

// ===========================================================================
// Machine identity + device grants
//
// The machine holds an ed25519 signing key (its identity, pinned out-of-band by
// clients) and an X25519 keypair for encrypting grants. A grant is signed by
// the machine and encrypted to the device's X25519 public key; the device
// verifies with the pinned signing key, decrypts with its own X25519 secret
// key, and receives the machine data root plus a per-device ingress root.
// ===========================================================================

export interface SigningKeyPair {
    /** base64 ed25519 public key (32 bytes). */
    publicKey: string;
    /** base64 ed25519 secret key (64 bytes) -- never leaves the machine. */
    secretKey: string;
}

export interface DeviceGrant {
    machineId: string;
    /** Machine ed25519 signing public key, base64; cross-checked against the pinned key. */
    machineSigningPublicKey: string;
    deviceId: string;
    /** Device X25519 public key the grant was encrypted to, base64. */
    devicePublicKey: string;
    keyVersion: number;
    /** Durable grants remain valid until explicit revocation. */
    expiresAt: number;
    /** 32-byte root for host->device data, base64. */
    dataKey: string;
    /** 32-byte root for device->host ingress, base64. */
    ingressKey: string;
}

export interface SealedDeviceGrant {
    v: 2;
    /** Machine X25519 public key that sealed the box, base64. */
    sender: string;
    /** base64(nonce || ciphertext), encrypted to the device X25519 public key. */
    box: string;
    /** Machine ed25519 signing public key, base64; must equal the pinned key. */
    signer: string;
    /** base64 detached ed25519 signature over the exact grant plaintext bytes. */
    sig: string;
}

/** Machine ed25519 identity. */
export function generateSigningKeyPair(): SigningKeyPair {
    const pair = nacl.sign.keyPair();
    return { publicKey: toBase64(pair.publicKey), secretKey: toBase64(pair.secretKey) };
}

/** Detached ed25519 signature (base64). */
export function signDetached(bytes: Uint8Array, secretKeyBase64: string): string {
    return toBase64(nacl.sign.detached(bytes, fromBase64(secretKeyBase64)));
}

export function verifyDetached(bytes: Uint8Array, signatureBase64: string, publicKeyBase64: string): boolean {
    return nacl.sign.detached.verify(bytes, fromBase64(signatureBase64), fromBase64(publicKeyBase64));
}

/**
 * Create a device grant: signed by the machine's ed25519 key, encrypted to the
 * device's X25519 public key. Carries the machine data key and per-device
 * ingress key plus its lifetime, key generation, and device binding.
 */
export function createDeviceGrant(params: {
    machineId: string;
    /** Machine ed25519 signing secret key, base64. */
    machineSigningSecretKey: string;
    /** Machine X25519 keypair; its public key travels in the grant as `sender`. */
    machineKey: KeyPair;
    deviceId: string;
    /** Device X25519 public key, base64 -- the grant is encrypted to this. */
    devicePublicKey: string;
    /** 32-byte root for host->device data, base64 or bytes. */
    dataKey: string | Uint8Array;
    /** 32-byte root for device->host ingress, base64 or bytes. */
    ingressKey: string | Uint8Array;
    keyVersion: number;
    /** Durable native grants use a parser-safe far-future timestamp. */
    expiresAt: number;
}): SealedDeviceGrant {
    const { machineId, deviceId, devicePublicKey, keyVersion, expiresAt } = params;
    if (typeof machineId !== 'string' || machineId === '') throw new Error('grant: machineId required');
    if (typeof deviceId !== 'string' || deviceId === '') throw new Error('grant: deviceId required');
    if (!Number.isInteger(keyVersion) || keyVersion < 2) throw new Error('grant: key generation must be 2 or newer');
    if (!Number.isFinite(expiresAt)) throw new Error('grant: expiresAt required');
    toKeyBytes(devicePublicKey, 'grant devicePublicKey');
    toKeyBytes(params.machineKey.secretKey, 'grant machineKey.secretKey');
    const signingSecret = fromBase64(params.machineSigningSecretKey);
    if (signingSecret.length !== nacl.sign.secretKeyLength) {
        throw new Error('grant: machineSigningSecretKey must be a 64-byte ed25519 secret key');
    }
    // tweetnacl ed25519 secret keys append the public key in the last 32 bytes.
    const machineSigningPublicKey = toBase64(signingSecret.subarray(nacl.sign.publicKeyLength));
    const grant: DeviceGrant = {
        machineId,
        machineSigningPublicKey,
        deviceId,
        devicePublicKey,
        keyVersion,
        expiresAt,
        dataKey: toBase64(toKeyBytes(params.dataKey, 'grant dataKey')),
        ingressKey: toBase64(toKeyBytes(params.ingressKey, 'grant ingressKey')),
    };
    const plaintext = encodeUtf8(JSON.stringify(grant));
    const nonce = nacl.randomBytes(nacl.box.nonceLength);
    const box = nacl.box(plaintext, nonce, fromBase64(devicePublicKey), fromBase64(params.machineKey.secretKey));
    return {
        v: 2,
        sender: params.machineKey.publicKey,
        box: toBase64(concatBytes(nonce, box)),
        signer: machineSigningPublicKey,
        sig: signDetached(plaintext, params.machineSigningSecretKey),
    };
}

/**
 * Verify a device grant with the pinned machine signing public key and the
 * device's own X25519 keypair. Fails closed on any mismatch: unknown version,
 * wrong pinned key, undecryptable box, bad signature, expired, or a device
 * binding that does not match the verifying key. Durable native devices use
 * explicit credential revocation and key rotation; short-lived browser grants
 * are additionally fenced by `expiresAt`.
 */
export function verifyDeviceGrant(
    grant: SealedDeviceGrant,
    opts: {
        /** The machine ed25519 public key the client pins out-of-band. */
        pinnedMachineSigningPublicKey: string;
        /** The device's X25519 keypair; the secret key decrypts the box. */
        deviceKey: KeyPair;
        /** Optional extra binding check against the grant's deviceId. */
        deviceId?: string;
    },
): DeviceGrant {
    if (grant === null || typeof grant !== 'object') throw new Error('grant: malformed grant');
    if (grant.v !== 2) throw new Error(`grant: unknown version ${grant.v}`);
    if (grant.signer !== opts.pinnedMachineSigningPublicKey) throw new Error('grant: signer is not the pinned machine key');
    toKeyBytes(opts.deviceKey.secretKey, 'grant deviceKey.secretKey');
    const boxBytes = fromBase64(grant.box);
    if (boxBytes.length < nacl.box.nonceLength) throw new Error('grant: malformed box');
    const nonce = boxBytes.subarray(0, nacl.box.nonceLength);
    const ciphertext = boxBytes.subarray(nacl.box.nonceLength);
    const opened = nacl.box.open(ciphertext, nonce, fromBase64(grant.sender), fromBase64(opts.deviceKey.secretKey));
    if (opened === null) throw new Error('grant: decryption failed (not addressed to this device key)');
    if (!verifyDetached(opened, grant.sig, opts.pinnedMachineSigningPublicKey)) {
        throw new Error('grant: signature verification failed');
    }
    let parsed: DeviceGrant;
    try {
        parsed = JSON.parse(decodeUtf8(opened)) as DeviceGrant;
    } catch {
        throw new Error('grant: malformed plaintext');
    }
    if (typeof parsed.machineId !== 'string' || parsed.machineId === '') throw new Error('grant: malformed machineId');
    if (parsed.machineSigningPublicKey !== opts.pinnedMachineSigningPublicKey) throw new Error('grant: signer mismatch');
    if (parsed.devicePublicKey !== opts.deviceKey.publicKey) throw new Error('grant: device binding mismatch');
    if (opts.deviceId !== undefined && parsed.deviceId !== opts.deviceId) throw new Error('grant: device id mismatch');
    if (typeof parsed.expiresAt !== 'number' || !Number.isFinite(parsed.expiresAt)) throw new Error('grant: invalid expiry');
    if (parsed.expiresAt <= Date.now()) throw new Error('grant: expired');
    if (!Number.isInteger(parsed.keyVersion) || parsed.keyVersion < 2) throw new Error('grant: invalid key generation');
    if (typeof parsed.dataKey !== 'string' || toKeyBytes(parsed.dataKey, 'grant dataKey').length !== 32) throw new Error('grant: invalid dataKey');
    if (typeof parsed.ingressKey !== 'string' || toKeyBytes(parsed.ingressKey, 'grant ingressKey').length !== 32) throw new Error('grant: invalid ingressKey');
    return parsed;
}
