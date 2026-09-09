import { pairingCodeHash, openPairingCodePayload } from '../../packages/crypto/dist/index.js';
import { fetchCommand } from './commands.mjs';
import { IosControls } from './iosSignals.mjs';

/** The same supported QR/deep-link pairing path as the iOS release runner. */
export async function pairIosPhone({ stack, udid, bundle = 'com.trymuxr.app', ui = new IosControls(udid) }) {
    const minted = await stack.mintPairing();
    if (!minted.code) throw new Error('Load host did not mint pairing code');
    try {
        const locator = new URL(minted.code);
        const shortCode = locator.searchParams.get('pair');
        if (!shortCode) throw new Error('Minted pairing locator has no code');
        locator.protocol = locator.protocol === 'wss:' ? 'https:' : 'http:';
        locator.pathname = '/v1/selfhost/pair-code';
        locator.search = '';
        const response = await fetchCommand(locator, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ code_hash: pairingCodeHash(shortCode) }),
        });
        if (!response.ok) throw new Error('Fresh pairing payload lookup failed');
        const payload = await response.json();
        const compact = openPairingCodePayload(payload.payload, shortCode);
        await ui.open(`pair?v=2&payload=${encodeURIComponent(compact)}`);
        await ui.waitFor(/THIS PHONE WILL BE ABLE TO|^Pair$/);
        if (!await ui.tapMatch(/^Pair$/, { optional: true })) {
            await ui.swipe(200, 720, 200, 350, .4);
            await ui.tapMatch(/^Pair$/);
        }
        await ui.waitFor(/^(LIVE|SPACES|Machine)$/, 90_000);
        return { ok: true, bundle, transport: 'fresh short-code QR deep-link consent and app handshake' };
    } finally {
        minted.release();
    }
}

export async function iosConnectionProof(ui, labels) {
    const nodes = await ui.ui();
    const values = nodes.map((node) => String(node.AXLabel ?? '').trim());
    const disconnected = values.some((value) => /^(disconnected|reconnecting|connecting)$/i.test(value));
    const connected = !disconnected && values.some((value) => /^connected$/i.test(value));
    const fixture = labels.find((label) => values.some((value) => value === label));
    return { connected, fixture, nodes };
}
