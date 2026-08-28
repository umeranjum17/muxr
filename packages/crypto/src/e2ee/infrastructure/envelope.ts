/**
 * v2 strict envelope (hosted control plane).
 *
 * Deterministic nonces (random restart epoch + monotonic u64 sequence), a
 * context authenticated by inclusion inside the sealed plaintext, and fail-
 * closed open: plaintext, malformed/unknown version, context mismatch, replay,
 * tamper, and wrong key all throw. Secretbox is XSalsa20-Poly1305.
 *
 * Wire form: `e2ee:v2:<base64(version(1) || epoch(16) || seq(8 BE) || box)>`
 * The box plaintext is one JSON record: every context field + the payload.
 * Opening re-derives the nonce from the envelope prefix, decrypts, then
 * cross-checks every embedded context field against the envelope and the
 * caller's expected context before touching replay state.
 */

import nacl from 'tweetnacl';
import { isRoutingChannel, type EnvelopeHeader, type RoutingChannel } from '@muxr/contract';
import { concatBytes, decodeUtf8, encodeUtf8, fromBase64, toBase64 } from './encoding.js';
import { toKeyBytes } from './keys.js';

export type V2Direction = 'host->client' | 'client->host';

const V2_PREFIX = 'e2ee:v2:';
const V2_VERSION = 2;
const V2_EPOCH_BYTES = 16;
const V2_SEQ_BYTES = 8;
const V2_KEY_LABEL = 'muxr.v2.key';

/** The context every seal is bound to. The receiver must supply the identical context to open. */
export interface V2Context {
    machineId: string;
    senderId: string;
    recipientId: string;
    channel: RoutingChannel;
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

function requireNonEmptyString(value: unknown, name: string): void {
    if (typeof value !== 'string' || value === '') throw new Error(`v2: ${name} required`);
}

function validateV2Context(ctx: V2Context): void {
    if (ctx === null || typeof ctx !== 'object') throw new Error('v2: context required');
    requireNonEmptyString(ctx.machineId, 'machineId');
    requireNonEmptyString(ctx.senderId, 'senderId');
    requireNonEmptyString(ctx.recipientId, 'recipientId');
    if (!isRoutingChannel(ctx.channel)) throw new Error('v2: unknown channel');
    requireNonEmptyString(ctx.streamId, 'streamId');
    if (!Number.isInteger(ctx.keyVersion) || ctx.keyVersion < 1) throw new Error('v2: key generation must be a positive integer');
}

/** Map a hosted Envelope routing header onto the E2EE context. Local/dev headers omit these fields. */
export function hostedRoutingContext(header: EnvelopeHeader): V2Context | undefined {
    if (header.senderId === undefined || header.recipientId === undefined
        || header.channel === undefined || header.streamId === undefined
        || header.keyVersion === undefined) {
        return undefined;
    }
    return {
        machineId: header.machineId,
        senderId: header.senderId,
        recipientId: header.recipientId,
        channel: header.channel,
        streamId: header.streamId,
        keyVersion: header.keyVersion,
    };
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

function sealedContextMatches(
    inner: Record<string, unknown>,
    expected: V2Context,
    epoch: string,
    seq: number,
): boolean {
    return inner['v'] === V2_VERSION
        && inner['m'] === expected.machineId
        && inner['s'] === expected.senderId
        && inner['r'] === expected.recipientId
        && inner['c'] === expected.channel
        && inner['st'] === expected.streamId
        && inner['kv'] === expected.keyVersion
        && inner['e'] === epoch
        && inner['q'] === seq;
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
    if (!sealedContextMatches(inner, expected, epoch, seq)) {
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
