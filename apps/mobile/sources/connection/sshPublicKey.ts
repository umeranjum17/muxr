import * as Crypto from 'expo-crypto';
import { decodeBase64, encodeBase64 } from '@/encryption/base64';

/**
 * Derives the public half of a pasted OpenSSH private key, so the one step
 * SSH setup actually needs — putting this phone's key in the host's
 * `~/.ssh/authorized_keys` — is one tap instead of a second tool.
 *
 * Private-key bytes never leave this function; only the public line and its
 * fingerprint are returned.
 */

export interface SshPublicKeyInfo {
    /** Wire algorithm name: `ssh-rsa`, `ecdsa-sha2-nistp256`, `ssh-ed25519`, … */
    algorithm: string;
    /** Single `authorized_keys` line: `<algorithm> <base64 blob>`. */
    publicKey: string;
    /** `SHA256:<base64>` fingerprint of the public blob (no padding). */
    fingerprint: string;
}

//
// SSH wire helpers: a string is a uint32 big-endian length plus bytes; an
// mpint is the same with a minimal two's-complement encoding.
//

function writeUint32(value: number, into: Uint8Array, at: number): void {
    into[at] = (value >>> 24) & 0xff;
    into[at + 1] = (value >>> 16) & 0xff;
    into[at + 2] = (value >>> 8) & 0xff;
    into[at + 3] = value & 0xff;
}

function sshString(bytes: Uint8Array): Uint8Array {
    const out = new Uint8Array(4 + bytes.length);
    writeUint32(bytes.length, out, 0);
    out.set(bytes, 4);
    return out;
}

function sshMpint(bytes: Uint8Array): Uint8Array {
    let start = 0;
    while (start < bytes.length - 1 && bytes[start] === 0) start += 1;
    const trimmed = bytes.subarray(start);
    const needsPad = (trimmed[0] & 0x80) !== 0;
    const body = needsPad ? new Uint8Array(trimmed.length + 1) : trimmed;
    if (needsPad) body.set(trimmed, 1);
    return sshString(body);
}

function readUint32(bytes: Uint8Array, pos: number): { value: number; next: number } {
    if (pos + 4 > bytes.length) throw new Error('truncated ssh uint32');
    const value = (bytes[pos] << 24 | bytes[pos + 1] << 16 | bytes[pos + 2] << 8 | bytes[pos + 3]) >>> 0;
    return { value, next: pos + 4 };
}

function readSshString(bytes: Uint8Array, pos: number): { value: Uint8Array; next: number } {
    const { value: length, next: at } = readUint32(bytes, pos);
    if (at + length > bytes.length) throw new Error('truncated ssh string');
    return { value: bytes.subarray(at, at + length), next: at + length };
}

//
// Minimal DER: enough to walk PKCS#1/PKCS#8/EC private keys.
//

interface DerNode {
    tag: number;
    content: Uint8Array;
}

function derRead(bytes: Uint8Array, pos: number): { node: DerNode; next: number } {
    if (pos + 2 > bytes.length) throw new Error('truncated DER');
    const tag = bytes[pos];
    let first = bytes[pos + 1];
    let length: number;
    let at = pos + 2;
    if (first < 0x80) {
        length = first;
    } else {
        const count = first & 0x7f;
        if (count > 4 || at + count > bytes.length) throw new Error('bad DER length');
        length = 0;
        for (let i = 0; i < count; i += 1) length = length * 256 + bytes[at + i];
        at += count;
    }
    if (at + length > bytes.length) throw new Error('truncated DER body');
    return { node: { tag, content: bytes.subarray(at, at + length) }, next: at + length };
}

function derChildren(content: Uint8Array): DerNode[] {
    const children: DerNode[] = [];
    let pos = 0;
    while (pos < content.length) {
        const { node, next } = derRead(content, pos);
        children.push(node);
        pos = next;
    }
    return children;
}

function derOid(content: Uint8Array): string {
    if (content.length === 0) throw new Error('empty OID');
    const parts = [Math.floor(content[0] / 40), content[0] % 40];
    let value = 0;
    for (let i = 1; i < content.length; i += 1) {
        value = value * 128 + (content[i] & 0x7f);
        if ((content[i] & 0x80) === 0) {
            parts.push(value);
            value = 0;
        }
    }
    return parts.join('.');
}

//
// Key formats.
//

const RSA_OID = '1.2.840.113549.1.1.1';
const EC_OID = '1.2.840.10045.2.1';
const CURVE_BY_OID: Record<string, string> = {
    '1.2.840.10045.3.1.7': 'nistp256',
    '1.3.132.0.34': 'nistp384',
    '1.3.132.0.35': 'nistp521',
};

/** PKCS#1 RSAPrivateKey: SEQUENCE { version, n, e, … } → `ssh-rsa` blob (exponent first, RFC 4253). */
function rsaBlobFromPkcs1(content: Uint8Array): Uint8Array {
    const ints = derChildren(content);
    if (ints.length < 3 || ints[1].tag !== 0x02 || ints[2].tag !== 0x02) throw new Error('not an RSA private key');
    const type = new TextEncoder().encode('ssh-rsa');
    return concat(sshString(type), sshMpint(ints[2].content), sshMpint(ints[1].content));
}

/** RFC 5915 ECPrivateKey: SEQUENCE { version, priv, [0] curve, [1] EXPLICIT BIT STRING pubkey } → `ecdsa-sha2-*` blob. */
function ecdsaBlobFromRfc5915(content: Uint8Array, algCurveOid?: Uint8Array): Uint8Array {
    const nodes = derChildren(content);
    const curveNode = nodes.find((node) => node.tag === 0xa0);
    const pubNode = nodes.find((node) => node.tag === 0xa1);
    if (pubNode === undefined) throw new Error('EC key without public point');
    // PKCS#8 names the curve in the AlgorithmIdentifier parameters; a bare
    // RFC 5915 [0] wraps the OID TLV explicitly, so unwrap one level.
    let oidContent: Uint8Array;
    if (algCurveOid !== undefined) oidContent = algCurveOid;
    else if (curveNode !== undefined) oidContent = derRead(curveNode.content, 0).node.content;
    else throw new Error('EC key without curve');
    const curve = CURVE_BY_OID[derOid(oidContent)];
    if (curve === undefined) throw new Error('unsupported EC curve');
    // [1] wraps the BIT STRING explicitly, so the BIT STRING is a nested TLV;
    // its content starts with an unused-bits byte, 0 for EC points.
    const bitString = derRead(pubNode.content, 0).node;
    const point = bitString.content.subarray(1);
    const type = new TextEncoder().encode(`ecdsa-sha2-${curve}`);
    return concat(sshString(type), sshString(new TextEncoder().encode(curve)), sshString(point));
}

function concat(...arrays: Uint8Array[]): Uint8Array {
    const total = arrays.reduce((n, a) => n + a.length, 0);
    const out = new Uint8Array(total);
    let offset = 0;
    for (const a of arrays) {
        out.set(a, offset);
        offset += a.length;
    }
    return out;
}

function blobFromPkcs8(content: Uint8Array): Uint8Array {
    const nodes = derChildren(content);
    const algorithm = nodes[1];
    const inner = nodes[2];
    if (algorithm === undefined || algorithm.tag !== 0x30 || inner === undefined || inner.tag !== 0x04) {
        throw new Error('unexpected PKCS#8 layout');
    }
    const parts = derChildren(algorithm.content);
    const oid = derOid(parts[0].content);
    // The OCTET STRING carries a whole inner key DER, SEQUENCE header included.
    const innerContent = derChildren(inner.content)[0].content;
    if (oid === RSA_OID) return rsaBlobFromPkcs1(innerContent);
    if (oid === EC_OID) return ecdsaBlobFromRfc5915(innerContent, parts[1]?.content);
    throw new Error('unsupported key algorithm');
}

/** openssh-key-v1: header strings, key count, then the raw public blob up front. */
function blobFromOpenSsh(bytes: Uint8Array): Uint8Array {
    const magic = new TextEncoder().encode('openssh-key-v1\0');
    for (let i = 0; i < magic.length; i += 1) {
        if (bytes[i] !== magic[i]) throw new Error('not an openssh-key-v1 key');
    }
    let pos = magic.length;
    for (let field = 0; field < 3; field += 1) pos = readSshString(bytes, pos).next; // ciphername, kdfname, kdfopts
    const { value: keyCount, next } = readUint32(bytes, pos);
    if (keyCount !== 1) throw new Error('unexpected key count');
    return readSshString(bytes, next).value;
}

//
// Entry point.
//

export async function sshPublicKeyFromPrivate(privateKeyPem: string): Promise<SshPublicKeyInfo | undefined> {
    const begin = privateKeyPem.match(/-----BEGIN ([A-Z0-9 ]+)-----/);
    if (begin === null || begin.index === undefined) return undefined;
    const beginIndex: number = begin.index;
    const endAt = privateKeyPem.indexOf('-----END', beginIndex + begin[0].length);
    if (endAt < 0) return undefined;
    const body = privateKeyPem.slice(beginIndex + begin[0].length, endAt).replace(/\s+/g, '');
    if (body === '') return undefined;
    let bytes: Uint8Array;
    try {
        bytes = decodeBase64(body);
    } catch {
        return undefined;
    }
    try {
        const label = begin[1];
        let blob: Uint8Array;
        if (label === 'OPENSSH PRIVATE KEY') {
            blob = blobFromOpenSsh(bytes);
        } else if (label === 'RSA PRIVATE KEY') {
            blob = rsaBlobFromPkcs1(derChildren(bytes)[0].content);
        } else if (label === 'PRIVATE KEY') {
            blob = blobFromPkcs8(derChildren(bytes)[0].content);
        } else if (label === 'EC PRIVATE KEY') {
            blob = ecdsaBlobFromRfc5915(derChildren(bytes)[0].content);
        } else {
            return undefined;
        }
        const { value: algorithm } = readSshString(blob, 0);
        // expo-crypto wants a plain ArrayBuffer-backed view.
        const digest = new Uint8Array(await Crypto.digest(Crypto.CryptoDigestAlgorithm.SHA256, new Uint8Array(blob)));
        const fingerprint = `SHA256:${encodeBase64(digest).replace(/=+$/, '')}`;
        return {
            algorithm: new TextDecoder().decode(algorithm),
            publicKey: `${new TextDecoder().decode(algorithm)} ${encodeBase64(blob)}`,
            fingerprint,
        };
    } catch {
        return undefined;
    }
}
