import { existsSync } from 'node:fs';
import { parseConnection, pairingIntent, pairingIntentFromHostedFlags } from '../domain/dist/index.js';
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
    if (typeof state?.relayUrl === 'string' && /^wss?:\/\/(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(state.relayUrl)) {
        print('  WARNING: this host uses the Wi-Fi-only route — the phone works only on this home network and will NOT work away from home. For access from anywhere, run `muxr setup`, choose a route that works away from home (Tailscale), then `muxr pair` again.');
    }
    return 0;
}

/**
 * Direct `muxr pair --browser` on a route that cannot host browsers offers the
 * one switch instead of dead-ending: enable the web client when the current
 * secure connection allows it, otherwise switch the route through setup and
 * continue pairing when the new route allows it. The interactive pieces arrive
 * by injection so application never imports presentation (and so the
 * setupWizard cycle stays one-directional); without them this degrades to the
 * exact next command. Returns true when browser hosting is ready and pairing
 * may continue, 'kept' when the user explicitly keeps the current route (exit
 * 0, pairing skipped), and false when pairing must stop with an error.
 */
async function offerBrowserRouteSwitch(state, deps = {}) {
    const connection = parseConnection(state);
    if (!connection.ok) {
        error('browser hosting is off. Run `muxr setup` to review the connection, then `muxr pair --browser` again.');
        return false;
    }
    if (state?.relayLocation === 'remote') {
        error(connection.value.rejectionForBrowserHosting() ?? 'browser hosting must be enabled by the shared-relay owner.');
        return false;
    }
    const interactive = process.stdin.isTTY && process.stdout.isTTY && typeof deps.select === 'function';
    if (connection.value.canEnableBrowserHosting()) {
        if (!interactive || typeof deps.enableBrowserHosting !== 'function') {
            error('browser hosting is off. Run `muxr`, choose Pair or manage devices, then Pair a control browser to enable it.');
            return false;
        }
        const choice = await deps.select('Browser access is off on this secure connection.', [
            { value: 'enable', title: 'Enable and pair browser', description: 'keep current settings; enable the web client, restart once, then create the link', recommended: true },
            { value: 'back', title: 'Keep it off', description: 'leave this computer unchanged' },
        ]);
        if (choice !== 'enable') return false;
        if (await deps.enableBrowserHosting() !== 0) return false;
        return browserHostingReady();
    }
    if (!interactive || typeof deps.applyMachineSetup !== 'function') {
        error('browsers cannot use this Wi-Fi-only route. Run `muxr setup` and choose a route that works away from home (Tailscale), then `muxr pair --browser` again. The Wi-Fi-only route pairs the phone app only on this home network and will NOT work away from home.');
        return false;
    }
    const choice = await deps.select('This Wi-Fi-only route cannot host browsers.', [
        { value: 'switch', title: 'Use muxr away from home (Tailscale)', description: 'review the route, apply it, then pair the browser', recommended: true },
        { value: 'keep', title: 'Keep the Wi-Fi-only route', description: 'phone app works only on this Wi-Fi and stops working away from home; browsers stay unavailable' },
    ]);
    if (choice !== 'switch') {
        print('Keeping the Wi-Fi-only route. The phone app keeps working on this home network only — it will NOT work away from home. Browsers stay unavailable; run `muxr setup` and choose a route that works away from home for access from anywhere.');
        return 'kept';
    }
    if (await deps.applyMachineSetup([]) !== 0) return false;
    if (!browserHostingReady()) {
        error('browser access is still off after setup. Run `muxr setup` to review the route, then `muxr pair --browser` again.');
        return false;
    }
    return true;
}

export async function pairDevice(args = [], deps = {}) {
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
        if (pair.requiresWebHosting && !browserHostingReady()) {
            const ready = await offerBrowserRouteSwitch(state, deps);
            if (ready === 'kept') return 0;
            if (!ready) return 1;
        }
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
        if (paired === 0) await approveScreenSharing({ pairingDone: true });
        return paired;
    } catch (cause) {
        error(cause instanceof Error ? cause.message : String(cause));
        return 1;
    }
}
