import { existsSync } from 'node:fs';
import { pairingIntent, pairingIntentFromHostedFlags } from '../domain/dist/index.js';
import { error, print } from '../infrastructure/runtime.mjs';
import { daemonDefinition, runDaemon } from '../infrastructure/daemon.mjs';
import { approveScreenSharing } from './approveScreenSharing.mjs';
import { linkPair } from './linkPair.mjs';
import { readSelfhostState, selfhostControlBase, selfhostCredential, selfhostRelayHealthy } from '../infrastructure/selfhost.mjs';
import { cliVersion, hostServiceVersion } from './inspectSetup.mjs';
import { browserHostingReady, ensureSelfhostRelay, relayDiscovery } from '../infrastructure/selfhostRelay.mjs';

export async function mintDeviceGrant(state, kind = 'native', authority = 'control', personal = false) {
    const record = await linkPair(state, { intent: pairingIntent({ kind, authority, personal }) });
    print(`  ✓ paired and verified ${record.name || 'device'}`);
    return 0;
}

export async function pairDevice(args = []) {
    try {
        const state = readSelfhostState();
        if (state?.machine?.crypto === undefined || typeof selfhostCredential(state) !== 'string') {
            throw new Error('muxr is not set up yet; run `muxr setup` first');
        }
        const cli = cliVersion();
        const running = hostServiceVersion();
        if (running && cli !== 'unknown' && running !== cli) {
            throw new Error(`This muxr command is ${cli} but your running muxr is ${running} — run \`muxr update\` from the active Node environment.`);
        }
        // A local relay may outlive the CLI that launched it. Check before
        // trying to restart it or minting a grant with an incompatible API.
        if (state.relayLocation !== 'remote') {
            const health = await fetch(`${selfhostControlBase(state)}/health`, { signal: AbortSignal.timeout(2_000) })
                .then((response) => response.ok ? response.json() : undefined).catch(() => undefined);
            if (typeof health?.muxrVersion === 'string' && cli !== 'unknown' && health.muxrVersion !== cli) {
                throw new Error(`This muxr command is ${cli} but your running muxr is ${health.muxrVersion} — run \`muxr update\` from the active Node environment.`);
            }
        }
        const pair = pairingIntentFromHostedFlags(args);
        if (pair.requiresWebHosting && !browserHostingReady()) throw new Error('browser hosting is off. Run `muxr`, choose Pair or manage devices, then Pair a control browser — muxr can enable browser access on your current secure connection.');
        let healthy = await selfhostRelayHealthy(state);
        if (!healthy) {
            const definition = daemonDefinition('selfhost');
            if (existsSync(definition.path)) await runDaemon(['restart']);
            else if (state.relayLocation !== 'remote') await ensureSelfhostRelay(state.relayPort, state.webRoot, state.bindHost, state.webOrigin, relayDiscovery(state));
            healthy = await selfhostRelayHealthy(state);
        }
        if (!healthy) throw new Error('the relay could not restart; run `muxr doctor` for the exact failing check');
        const paired = await mintDeviceGrant(state, pair.kind, pair.authority, pair.personal);
        // The person pairing is at this computer, which is the only place the
        // desktop's screen-sharing prompt can be answered.
        if (paired === 0) await approveScreenSharing();
        return paired;
    } catch (cause) {
        error(cause instanceof Error ? cause.message : String(cause));
        return 1;
    }
}
