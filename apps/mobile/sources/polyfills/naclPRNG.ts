/*
 * tweetnacl probes for a CSPRNG once, at module load: self.crypto on web,
 * require('crypto') on node. Hermes has neither, so randombytes stays the
 * stub that throws 'no PRNG' and every E2EE frame from @muxr/crypto
 * dies -- the app connects to the relay and then shows an empty herd.
 * setPRNG is order-independent; the load-time probe is not.
 */
import { getRandomValues } from 'expo-crypto';
import nacl from 'tweetnacl';

nacl.setPRNG((x, n) => {
    getRandomValues(x.subarray(0, n));
});
