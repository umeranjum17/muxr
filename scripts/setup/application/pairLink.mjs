import { randomBytes } from 'node:crypto';
import { error, print, printTerminalQr } from '../infrastructure/runtime.mjs';
import { readSelfhostState, writeSelfhostState } from '../infrastructure/selfhost.mjs';
import { withSelfhostRotationLock } from '../infrastructure/selfhostRelay.mjs';

/**
 * This computer's one pairing link: `http(s)://<tailnet address>/join#<secret>`.
 *
 * The secret rides after `#`, so opening the link never sends it to a server;
 * the phone app reads it and asks the relay at that address for a fresh,
 * auto-approved pairing offer (the host checks the secret over pair.sock).
 * It lives in selfhost.json beside the device grants and stays the same across
 * restarts. Revoking a device or rotating the machine keys removes it, so a
 * removed device cannot pair again through an old copy; `muxr link` makes the
 * next one.
 */

/** The link's address on the relay's own route, or undefined when that route is not a tailnet. */
export function pairLinkBase(relayUrl) {
    let url;
    try { url = new URL(relayUrl); } catch { return undefined; }
    const host = url.hostname.toLowerCase();
    const ip = /^100\.(\d+)\.\d+\.\d+$/.exec(host);
    const tailnet = host.endsWith('.ts.net') || (ip !== null && Number(ip[1]) >= 64 && Number(ip[1]) <= 127);
    if (!tailnet || (url.protocol !== 'ws:' && url.protocol !== 'wss:')) return undefined;
    return `${url.protocol === 'wss:' ? 'https' : 'http'}://${url.host}/join`;
}

/** The secret for this computer's link, made once and kept; `fresh` replaces it. */
async function pairLinkSecret(fresh) {
    return withSelfhostRotationLock(async () => {
        const state = readSelfhostState();
        const crypto = state?.machine?.crypto;
        if (crypto === undefined) throw new Error('muxr is not set up yet; run `muxr setup` first');
        if (typeof crypto.pairLink === 'string' && !fresh) return crypto.pairLink;
        crypto.pairLink = randomBytes(32).toString('base64url');
        writeSelfhostState(state);
        return crypto.pairLink;
    });
}

/** Print the link and its QR. `--new` replaces the link, so copies already shared stop working. */
export async function pairLink(args = []) {
    try {
        const state = readSelfhostState();
        if (state?.machine?.crypto === undefined) throw new Error('muxr is not set up yet; run `muxr setup` first');
        const base = pairLinkBase(state.relayUrl);
        if (base === undefined) {
            throw new Error(`this computer's route (${state.relayUrl ?? 'none'}) is not a tailnet, so it has no pairing link. Run \`muxr setup\` and choose Tailscale, or pair with \`muxr pair --code\`.`);
        }
        const link = `${base}#${await pairLinkSecret(args.includes('--new'))}`;
        print('');
        print('Pair a phone: open this link on it, or scan the QR.');
        print(link);
        await printTerminalQr(link);
        print('With muxr installed, the link opens it and pairs in one tap; without it, the page says how to install, then open the link again.');
        print('The phone needs Tailscale on, signed in to the same tailnet. The link stays the same; keep it private, like a key.');
        if (args.includes('--new')) print('  ✓ new link; the old one no longer pairs');
        return 0;
    } catch (cause) {
        error(cause instanceof Error ? cause.message : String(cause));
        return 1;
    }
}
