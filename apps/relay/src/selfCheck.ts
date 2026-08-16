/**
 * Assert-based self-check for the pairing rendezvous.
 * Run: node apps/relay/dist/selfCheck.js
 */

import { isValidPublicKey, PairingRequests } from './pairing.js';

function assert(condition: boolean, message: string): void {
    if (!condition) throw new Error(message);
}

const keyA = Buffer.alloc(32, 1).toString('base64');
const keyB = Buffer.alloc(32, 2).toString('base64');

function demo(): void {
    assert(isValidPublicKey(keyA), '32-byte base64 must be accepted');
    assert(!isValidPublicKey(Buffer.alloc(31).toString('base64')), 'wrong length must be rejected');
    assert(!isValidPublicKey('not base64 at all!!'), 'junk must be rejected');
    assert(!isValidPublicKey(undefined), 'missing key must be rejected');

    let clock = 1_000_000;
    const pairing = new PairingRequests(() => clock);

    // Create-or-poll: the client posts the same request to start and to poll.
    assert(pairing.request(keyA)?.state === 'requested', 'first request should be pending');
    assert(pairing.request(keyA)?.state === 'requested', 'polling must not reset state');
    assert(pairing.size === 1, 'polling must not create a second entry');

    assert(!pairing.approve(keyB, 'sealed', 'acctok_x'), 'approving an unknown key must fail');

    assert(pairing.approve(keyA, 'sealed-blob', 'acctok_1'), 'approve should succeed');
    const authorized = pairing.request(keyA);
    assert(authorized?.state === 'authorized', 'approved request should report authorized');
    if (authorized?.state === 'authorized') {
        assert(authorized.response === 'sealed-blob', 'sealed blob must round-trip untouched');
        assert(authorized.token === 'acctok_1', 'approver account token must be handed back');
    }

    // Expiry: an abandoned pairing must not linger.
    clock += 11 * 60 * 1000;
    assert(pairing.request(keyB)?.state === 'requested', 'new request after expiry window');
    assert(pairing.size === 1, `expired entry should be swept, size=${pairing.size}`);
    assert(!pairing.approve(keyA, 'late', 'acctok_1'), 'expired request must not be approvable');

    // Cap: an unauthenticated flood must not grow without bound.
    const flood = new PairingRequests(() => clock);
    for (let i = 0; i < 100; i += 1) {
        const key = Buffer.alloc(32);
        key.writeUInt32BE(i);
        flood.request(key.toString('base64'));
    }
    assert(flood.size === 100, `flood should fill the cap, size=${flood.size}`);
    assert(flood.request(keyA) === undefined, 'requests past the cap must be refused');

    process.stdout.write(`PASS: relay selfCheck (pairing rendezvous, expiry, cap)\n`);
}

demo();
