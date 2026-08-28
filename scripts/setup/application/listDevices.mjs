import { error, print } from '../infrastructure/runtime.mjs';
import { readSelfhostState, selfhostCredential } from '../infrastructure/selfhost.mjs';
import { selfhostDevices } from '../infrastructure/selfhostRelay.mjs';

export async function listDevices() {
    try {
        const state = readSelfhostState();
        if (state?.machine?.crypto === undefined || typeof selfhostCredential(state) !== 'string') {
            throw new Error('no self-host pairing state; run `muxr self-host` first');
        }
        const devices = await selfhostDevices(state);
        if (devices.length === 0) print('No paired devices.');
        else devices.forEach((device, index) => print(`  ${index + 1}. ${device.name || 'phone'} — paired ${new Date(device.createdAt).toLocaleDateString()}`));
        return 0;
    } catch (cause) {
        error(cause instanceof Error ? cause.message : String(cause));
        return 1;
    }
}
