import { error, print } from '../infrastructure/runtime.mjs';
import { readSelfhostState, writeSelfhostState } from '../infrastructure/selfhost.mjs';
import { selfhostDevices, withSelfhostRotationLock } from '../infrastructure/selfhostRelay.mjs';

export async function revokeDevice(args = []) {
    try {
        await withSelfhostRotationLock(async () => {
            const state = readSelfhostState();
            if (state?.machine?.crypto === undefined) throw new Error('no self-host pairing state; run `muxr self-host` first');
            if (state.machine.crypto.pendingRotation !== undefined) {
                throw new Error('an old device-key rotation is unfinished; run `muxr doctor` before changing grants');
            }
            const reference = args.join(' ').trim();
            if (reference === '') throw new Error('choose a device from `muxr devices list`');
            const devices = await selfhostDevices(state);
            const position = /^\d+$/.test(reference) ? Number(reference) - 1 : -1;
            const named = devices.filter((device) => device.name?.toLowerCase() === reference.toLowerCase());
            const target = position >= 0 ? devices[position] : named.length === 1 ? named[0] : undefined;
            if (target === undefined) throw new Error(named.length > 1 ? 'device name is ambiguous; use its list number' : 'device not found');
            state.machine.crypto.devices = state.machine.crypto.devices.filter((device) => device.deviceId !== target.deviceId);
            writeSelfhostState(state);
            // The running link watches this durable record and revokes the grant,
            // socket and push registration; while it is offline, trust checks fail
            // closed and it reconciles the record before admitting a device.
            print(`  ✓ revoked ${target.name || 'phone'}`);
        });
        return 0;
    } catch (cause) {
        error(cause instanceof Error ? cause.message : String(cause));
        return 1;
    }
}
