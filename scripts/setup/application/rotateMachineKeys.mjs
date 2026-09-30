import { createHash } from 'node:crypto';
import { hostId } from '@byokit/link';
import { error, flagValue, machineIdentity, print, run } from '../infrastructure/runtime.mjs';
import { readSelfhostState, selfhostControlBase, selfhostCredential, selfhostRelayHealthy, writeSelfhostState } from '../infrastructure/selfhost.mjs';
import { daemonIsRunning, runDaemon } from '../infrastructure/daemon.mjs';
import { hostEntry } from '../infrastructure/paths.mjs';
import { withSelfhostRotationLock } from '../infrastructure/selfhostRelay.mjs';

const fingerprint = (publicKey) => createHash('sha256').update(publicKey).digest('hex').slice(0, 16);

/**
 * Replaces the machine signing, box and data keys. Every paired device pinned
 * the old box key, so all pairings end.
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
            const wasRunning = daemonIsRunning();
            if (wasRunning && await runDaemon(['stop']) !== 0) throw new Error('could not stop the muxr service; machine keys were not rotated');
            const dataDir = flagValue(args, '--data-dir');
            const hostArgs = [hostEntry()];
            if (dataDir !== undefined) hostArgs.push('--data-dir', dataDir);
            const stopped = run(process.execPath, [...hostArgs, '--check-host-stopped']);
            if (!stopped.ok) throw new Error(stopped.stderr || 'could not verify host quiescence; the muxr service was left stopped');
            print(stopped.stdout);
            const fresh = machineIdentity(undefined).crypto;
            state.machine.publicKey = fresh.signingPublicKey;
            state.machine.crypto = { ...fresh, keyVersion: old.keyVersion + 1 };
            writeSelfhostState(state);
            print(`  ✓ signing key ${fingerprint(old.signingPublicKey)} → ${fingerprint(fresh.signingPublicKey)}`);
            print(`  ✓ box key (host ${oldHost}) → host ${hostId(Buffer.from(fresh.boxPublicKey, 'base64'))}`);
            print(`  ✓ data key replaced; key version ${old.keyVersion} → ${old.keyVersion + 1}`);
            print(`  ✓ ${old.devices.length} device pairing(s) removed`);
            const peers = run(process.execPath, [...hostArgs, '--retire-machine-peers']);
            if (!peers.ok) throw new Error(`peer cleanup incomplete; the muxr service was left stopped: ${peers.stderr || 'could not retire machine peer relationships'}`);
            print(peers.stdout);
            if (wasRunning && await runDaemon(['start']) !== 0) throw new Error(`could not start the muxr service; old host ${oldHost} is still registered on the relay; run \`muxr daemon start\`, then retry retirement of that host`);
            try {
                const deadline = Date.now() + 30_000;
                for (;;) {
                    const remaining = deadline - Date.now();
                    if (remaining <= 0) throw new Error('relay readiness timed out');
                    if (await selfhostRelayHealthy(state, Math.min(2_000, remaining))) break;
                    await new Promise((resolve) => setTimeout(resolve, Math.min(250, Math.max(0, deadline - Date.now()))));
                }
                const retired = await fetch(`${selfhostControlBase(state)}/relay/v1/hosts/${oldHost}`, {
                    method: 'DELETE', headers: { authorization: `Bearer ${selfhostCredential(state)}` }, signal: AbortSignal.timeout(15_000),
                });
                if (!retired.ok) throw new Error('relay retirement failed');
            } catch {
                throw new Error(`machine keys replaced, but old host ${oldHost} is still registered on the relay; restore relay access, then retry DELETE /relay/v1/hosts/${oldHost} with the owner credential`);
            }
            print(`  ✓ old host ${oldHost} retired from the relay`);
        });
        print('  next: pair each device again with `muxr pair`; inbound peer collaborations were retired and can be set up again');
        return 0;
    } catch (cause) {
        error(cause instanceof Error ? cause.message : String(cause));
        return 1;
    }
}
