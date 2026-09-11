import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import nacl from 'tweetnacl';
import { resolveOperatorConfig } from '../infrastructure/operatorConfig.mjs';
import {
    pairingIntent,
    pairingIntentFromHostedFlags,
} from '../domain/dist/index.js';
import {
    api,
    base64,
    createDeviceGrant,
    deriveV2Key,
    error,
    executable,
    hostPlatform,
    newPairingCode,
    newV2ReplayTracker,
    openV2,
    pairingCodeHash,
    print,
    printTerminalQr,
    run,
    sealPairingCodePayload,
    stateDir,
} from '../infrastructure/runtime.mjs';
import { daemonDefinition, runDaemon } from '../infrastructure/daemon.mjs';
import {
    readSelfhostState,
    selfhostControlBase,
    selfhostCredential,
    selfhostRelayHealthy,
    writeSelfhostState,
} from '../infrastructure/selfhost.mjs';
import {
    browserHostingReady,
    ensureSelfhostRelay,
    relayDiscovery,
    withSelfhostRotationLock,
} from '../infrastructure/selfhostRelay.mjs';

/**
 * Best-effort convenience only: open a browser pairing link on an
 * interactive graphical local session. The printed link and
 * pairing-string.txt stay authoritative; opener failure only warns and
 * never fails pairing. Never opens headless, over SSH, or without a
 * display — and never for non-HTTPS values.
 */
function maybeOpenPairUrl(pairValue, isBrowserLink) {
    if (!isBrowserLink || typeof pairValue !== 'string' || !pairValue.startsWith('https://')) return;
    if (!process.stdout.isTTY) return;
    if (process.env.SSH_CONNECTION || process.env.SSH_CLIENT || process.env.SSH_TTY || process.env.TERMUX_VERSION) return;
    if (hostPlatform() !== 'darwin' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) return;
    const opener = hostPlatform() === 'darwin' ? 'open' : 'xdg-open';
    if (executable(opener) === undefined) return;
    try {
        if (!run(opener, [pairValue], { timeout: 15_000 }).ok) {
            print('  warn: could not open the browser automatically; use the link above');
        }
    } catch {
        print('  warn: could not open the browser automatically; use the link above');
    }
}

export async function mintDeviceGrant(state, requestedKind = 'native', requestedAuthority = 'control', requestedPersonal = false) {
    const intent = pairingIntent({ kind: requestedKind, authority: requestedAuthority, personal: requestedPersonal });
    const base = selfhostControlBase(state);
    const authHeaders = { authorization: `Bearer ${selfhostCredential(state)}` };
    let pending = state.machine.crypto.pendingPair;
    let recoveredPoll;
    if (pending !== undefined && typeof pending.expiresAt === 'number' && pending.expiresAt <= Date.now()) {
        // A claimed relay session remains recoverable after its local display
        // deadline. Poll once before discarding the only copy of its pair key.
        const polled = await api(base, `/v1/selfhost/pair-sessions/${encodeURIComponent(pending.pairId)}`, { headers: authHeaders });
        if (!polled.response.ok) {
            if (polled.response.status !== 403 && polled.response.status !== 404) throw new Error(polled.body.error || 'pair recovery polling failed');
            delete state.machine.crypto.pendingPair;
            writeSelfhostState(state);
            pending = undefined;
        } else if (polled.body.state === 'claimed') recoveredPoll = polled;
        else if (polled.body.state === 'expired') {
            delete state.machine.crypto.pendingPair;
            writeSelfhostState(state);
            pending = undefined;
        }
    }
    if (pending !== undefined && recoveredPoll === undefined
        && (!intent.matchesPending(pending) || typeof pending.pairString !== 'string')) {
        delete state.machine.crypto.pendingPair;
        writeSelfhostState(state);
        pending = undefined;
    }
    if (pending === undefined) {
        const claim = randomBytes(32).toString('base64url');
        const pairSecret = randomBytes(32).toString('base64url');
        const created = await api(base, '/v1/selfhost/pair-sessions', {
            method: 'POST',
            headers: authHeaders,
            body: JSON.stringify({ claim, machineSlug: state.machine.id, deviceKind: requestedKind, authority: requestedAuthority, ...(intent.personal ? { personal: true } : {}) }),
        });
        if (!created.response.ok) throw new Error(created.body.error || `pair session failed (${created.response.status})`);
        const payload = Buffer.from(JSON.stringify({
            v: '2',
            generation: String(state.machine.crypto.keyVersion),
            id: created.body.pair_id,
            claim,
            pair: pairSecret,
            machine: state.machine.id,
            name: state.machine.name ?? 'self-host',
            machinePk: state.machine.crypto.signingPublicKey,
            r: state.relayUrl,
            authority: requestedAuthority,
        })).toString('base64url');
        const code = newPairingCode();
        const published = await api(base, `/v1/selfhost/pair-sessions/${encodeURIComponent(created.body.pair_id)}/code`, {
            method: 'POST',
            headers: authHeaders,
            body: JSON.stringify({ code_hash: pairingCodeHash(code), payload: sealPairingCodePayload(payload, code) }),
        });
        if (!published.response.ok) throw new Error(published.body.error || 'pairing code publication failed');
        const pairString = intent.pairingLocator(state.relayUrl, code);
        pending = {
            pairId: created.body.pair_id,
            pairSecret,
            generation: state.machine.crypto.keyVersion,
            pairString,
            expiresAt: Date.now() + Number(created.body.expires_in ?? 120) * 1000,
            deviceKind: requestedKind,
            authority: requestedAuthority,
            personal: intent.personal,
        };
        state.machine.crypto.pendingPair = pending;
        writeSelfhostState(state);
    }
    if (pending.grant !== undefined && pending.device !== undefined) {
        if (pending.grantUploaded !== true) {
            const uploaded = await api(base, `/v1/selfhost/pair-sessions/${encodeURIComponent(pending.pairId)}/grant`, {
                method: 'POST', headers: authHeaders, body: JSON.stringify({ grant: pending.grant }),
            });
            if (!uploaded.response.ok) throw new Error(uploaded.body.error || 'grant upload recovery failed');
            pending.grantUploaded = true;
            state.machine.crypto.pendingPair = pending;
            writeSelfhostState(state);
        }
        if (pairingIntent({ kind: pending.deviceKind, authority: pending.authority, personal: pending.personal }).requiresWebHosting) {
            const deadline = Date.now() + 2 * 60_000;
            let acknowledged = false;
            while (Date.now() < deadline) {
                const polled = await api(base, `/v1/selfhost/pair-sessions/${encodeURIComponent(pending.pairId)}`, { headers: authHeaders });
                if (!polled.response.ok) throw new Error(polled.body.error || 'pairing acknowledgement failed');
                if (polled.body.acknowledged === true) { acknowledged = true; break; }
                await new Promise((resolve) => setTimeout(resolve, 1000));
            }
            if (!acknowledged) throw new Error('the browser claimed the pairing but did not save it; reload the browser to recover, then rerun `muxr pair --browser` if needed');
        }
        state.machine.crypto.devices = [
            ...state.machine.crypto.devices.filter((entry) => entry.deviceId !== pending.device.deviceId),
            pending.device,
        ];
        delete state.machine.crypto.pendingPair;
        writeSelfhostState(state);
        print(`  ✓ paired and verified ${pending.deviceName || 'device'}`);
        return 0;
    }

    if (recoveredPoll === undefined) {
        print('');
        const waiting = pairingIntent({ kind: pending.deviceKind, authority: pending.authority, personal: pending.personal });
        if (!waiting.requiresWebHosting) {
            print('Open the muxr app on your phone before scanning.');
            print('  Android: https://github.com/umeranjum17/muxr/releases/latest');
            print('  iPhone: https://testflight.apple.com/join/aJSbs8pN — Apple is not accepting new testers right now');
            print('Not ready? Press Ctrl-C and run `muxr pair` later.');
            print('');
        }
        const pairValue = pending.pairString;
        if (typeof pairValue !== 'string') throw new Error('pairing string is unavailable');
        if (!waiting.requiresWebHosting && process.stdout.isTTY) await printTerminalQr(pairValue);
        print(waiting.requiresWebHosting
            ? waiting.promptLine()
            : 'Pairing string (expires in two minutes):');
        print(pairValue);
        if (waiting.requiresWebHosting) print(`Browser access expires after ${waiting.grantDurationLabel()}.`);
        maybeOpenPairUrl(pairValue, waiting.requiresWebHosting);
        const pairFile = join(stateDir(), 'pairing-string.txt');
        writeFileSync(pairFile, `${pairValue}\n`, { mode: 0o600 });
        // wl-copy/xclip stay alive as clipboard owners and can freeze setup in a
        // terminal or headless session. macOS pbcopy writes once and exits.
        const clipboard = hostPlatform() === 'darwin'
            ? spawnSync('pbcopy', [], { input: pairValue, timeout: 2_000 })
            : undefined;
        print(clipboard?.status === 0 ? '  ✓ copied link to clipboard' : `  saved exact link to ${pairFile}`);
        print(`Waiting for the ${waiting.requiresWebHosting ? 'browser' : 'device'} to finish pairing…`);
    }
    while (true) {
        let polled = recoveredPoll;
        recoveredPoll = undefined;
        if (polled === undefined) {
            await new Promise((resolve) => setTimeout(resolve, 2000));
            polled = await api(base, `/v1/selfhost/pair-sessions/${encodeURIComponent(pending.pairId)}`, { headers: authHeaders });
        }
        if (!polled.response.ok) throw new Error(polled.body.error || 'pair polling failed');
        if (polled.body.state === 'pending') continue;
        if (polled.body.state === 'expired') {
            delete state.machine.crypto.pendingPair;
            writeSelfhostState(state);
            if (requestedKind === 'native') {
                print('Pairing QR expired — creating a fresh one…');
                // ponytail: one promise frame per renewal; use an outer loop if unattended pairing lasts hours.
                return mintDeviceGrant(state, requestedKind, requestedAuthority, requestedPersonal);
            }
            throw new Error('browser pairing session expired; run `muxr pair --browser` for a fresh link');
        }
        if (polled.body.state !== 'claimed') throw new Error(`pairing session ${polled.body.state}`);
        const mailbox = polled.body.mailbox;
        const deviceId = polled.body.deviceId;
        const devicePublicKey = polled.body.devicePublicKey;
        if (typeof mailbox !== 'string' || typeof deviceId !== 'string' || typeof devicePublicKey !== 'string') throw new Error('pairing mailbox is unavailable');
        const plaintext = openV2(mailbox, deriveV2Key(pending.pairSecret, 'client->host'), {
            machineId: state.machine.id,
            senderId: devicePublicKey,
            recipientId: state.machine.id,
            channel: 'pairing',
            streamId: pending.pairId,
            keyVersion: pending.generation ?? 1,
        }, newV2ReplayTracker());
        const request = JSON.parse(plaintext);
        if (request.devicePublicKey !== devicePublicKey || request.machineSigningPublicKey !== state.machine.crypto.signingPublicKey) {
            const mismatch = [
                request.devicePublicKey !== devicePublicKey && 'device',
                request.machineSigningPublicKey !== state.machine.crypto.signingPublicKey && 'machine',
            ].filter(Boolean).join(' and ');
            throw new Error(`pairing mailbox substitution rejected (${mismatch} key mismatch)`);
        }
        const ingressKey = base64(nacl.randomBytes(32));
        const claimed = pairingIntent({ kind: pending.deviceKind, authority: pending.authority, personal: pending.personal });
        if (polled.body.authority !== undefined && polled.body.authority !== claimed.authority) {
            throw new Error('pairing authority substitution rejected');
        }
        const expiresAt = claimed.grantExpiresAt();
        pending.device = claimed.deviceRecord({ deviceId, devicePublicKey, ingressKey, expiresAt });
        pending.deviceName = typeof request.deviceName === 'string' && request.deviceName.trim() !== '' ? request.deviceName.trim() : 'phone';
        pending.grant = JSON.stringify(createDeviceGrant({
            machineId: state.machine.id,
            machineSigningSecretKey: state.machine.crypto.signingSecretKey,
            machineKey: { publicKey: state.machine.crypto.boxPublicKey, secretKey: state.machine.crypto.boxSecretKey },
            deviceId,
            devicePublicKey,
            dataKey: state.machine.crypto.dataKey,
            ingressKey,
            keyVersion: state.machine.crypto.keyVersion,
            expiresAt,
            authority: claimed.authority,
        }));
        state.machine.crypto.pendingPair = pending;
        writeSelfhostState(state);
        return mintDeviceGrant(state, claimed.kind, claimed.authority, claimed.personal);
    }
}

/** No explicit grant flag: MUXR_PAIRING_DEFAULT (config.env, default browser Control) decides. `--native` is the explicit QR. */
function withPairingDefault(args) {
    const explicit = ['--browser', '--browser-view', '--browser-personal', '--native', '--phone'];
    if (args.some((arg) => explicit.includes(arg))) return args.filter((arg) => arg !== '--native' && arg !== '--phone');
    let preferred = 'browser';
    try { preferred = resolveOperatorConfig({ args: [] }).values.pairingDefault ?? 'browser'; } catch { /* invalid config: the setup path reports it; pairing keeps the default */ }
    const flag = { browser: '--browser', 'browser-view': '--browser-view', 'browser-personal': '--browser-personal', native: undefined, none: null }[preferred];
    if (flag === null) throw new Error('MUXR_PAIRING_DEFAULT=none: pass --browser, --browser-view, --browser-personal or --native to pair explicitly');
    return flag === undefined ? args : [...args, flag];
}

export async function pairDevice(rawArgs = []) {
    try {
        const args = withPairingDefault(rawArgs);
        const state = readSelfhostState();
        if (state?.machine?.crypto === undefined || typeof selfhostCredential(state) !== 'string') {
            throw new Error('muxr is not set up yet; run `muxr setup` first');
        }
        const pair = pairingIntentFromHostedFlags(args);
        if (pair.requiresWebHosting && !browserHostingReady()) {
            const route = typeof state.connectionMode === 'string' ? state.connectionMode : 'unknown';
            throw new Error(`browser hosting is off: the browser app needs an HTTPS route — MUXR_CONNECTION=tailscale (Serve), cloudflare, or external (your own wss:// origin) with MUXR_WEB=true; this computer is set up with ${route}. Run \`muxr\` and choose Set up, or set those keys in ~/.muxr/config.env and run \`muxr setup --apply-config\`; the native app (\`muxr pair --native\`) works on any route.`);
        }
        let healthy = await selfhostRelayHealthy(state);
        if (!healthy) {
            const definition = daemonDefinition('selfhost');
            if (existsSync(definition.path)) await runDaemon(['restart']);
            else if (state.relayLocation !== 'remote') await ensureSelfhostRelay(state.relayPort, state.webRoot, state.bindHost, state.webOrigin, relayDiscovery(state));
            healthy = await selfhostRelayHealthy(state);
        }
        if (!healthy) throw new Error('the relay could not restart; run `muxr doctor` for the exact failing check');
        return await withSelfhostRotationLock(() => mintDeviceGrant(state, pair.kind, pair.authority, pair.personal));
    } catch (cause) {
        error(cause instanceof Error ? cause.message : String(cause));
        return 1;
    }
}
