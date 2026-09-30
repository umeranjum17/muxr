import { createHash } from 'node:crypto';
import { hostId } from '@byokit/link';
import { error, machineIdentity, print } from '../infrastructure/runtime.mjs';
import { readSelfhostState, selfhostControlBase, selfhostCredential, writeSelfhostState } from '../infrastructure/selfhost.mjs';
import { withSelfhostRotationLock } from '../infrastructure/selfhostRelay.mjs';

const fingerprint = (publicKey) => createHash('sha256').update(publicKey).digest('hex').slice(0, 16);

/**
 * Replaces the machine signing, box and data keys. Every paired device pinned
 * the old box key, so all pairings end; the relay forgets the old host id
 * before the new keys are written, so the old key can never answer again.
 */
export async function rotateMachineKeys(args = []) {
    try {
        if (!args.includes('--unpair-all')) {
            throw new Error('rotating the machine keys unpairs every device; rerun with --unpair-all to confirm');
        }
        await withSelfhostRotationLock(async () => {
            const state = readSelfhostState();
            const old = state?.machine?.crypto;
            if (old === undefined) throw new Error('no self-host pairing state; run `muxr self-host` first');
            if (old.pendingRotation !== undefined) throw new Error('an old device-key rotation is unfinished; run `muxr doctor` first');
            if (state.relayLocation === 'remote') throw new Error('a remote relay pins this machine by its signing key; ask its owner for a fresh enrollment instead');
            const oldHost = hostId(Buffer.from(old.boxPublicKey, 'base64'));
            const retired = await fetch(`${selfhostControlBase(state)}/relay/v1/hosts/${oldHost}`, {
                method: 'DELETE', headers: { authorization: `Bearer ${selfhostCredential(state)}` }, signal: AbortSignal.timeout(15_000),
            });
            if (!retired.ok) throw new Error(`the relay did not retire the old host (${retired.status}); start the relay and retry`);
            const fresh = machineIdentity(undefined).crypto;
            state.machine.publicKey = fresh.signingPublicKey;
            state.machine.crypto = { ...fresh, keyVersion: old.keyVersion + 1 };
            writeSelfhostState(state);
            print(`  ✓ signing key ${fingerprint(old.signingPublicKey)} → ${fingerprint(fresh.signingPublicKey)}`);
            print(`  ✓ box key (host ${oldHost}) → host ${hostId(Buffer.from(fresh.boxPublicKey, 'base64'))}`);
            print(`  ✓ data key replaced; key version ${old.keyVersion} → ${old.keyVersion + 1}`);
            print(`  ✓ ${old.devices.length} device pairing(s) removed; old host retired from the relay`);
            print('  next: `muxr restart`, then pair each device again with `muxr pair`; linked peer computers must be re-authorized');
        });
        return 0;
    } catch (cause) {
        error(cause instanceof Error ? cause.message : String(cause));
        return 1;
    }
}
