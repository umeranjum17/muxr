import { advertisedUrlForMode, parseConnection } from './connection.js';
import { parseEnrollment } from './enrollment.js';
import { parseDevice, parseMachineCrypto, validMachineCrypto } from './machineCrypto.js';
import { BROWSER_PERSONAL_GRANT_TTL_MS, consentMachineName, pairingIntent, pairingIntentFromDevice, pairingIntentFromHostedFlags } from './pairing.js';

function assert(condition: boolean, message: string): asserts condition {
    if (!condition) throw new Error(message);
}

function runSelfCheck(): void {
    const native = pairingIntent({ kind: 'native' });
    assert(native.authority === 'control', 'native pairing is always control');
    assert(native.grantExpiresAt(0) > Date.now(), 'native grants are durable');
    assert(!native.requiresWebHosting, 'native pairing does not require browser hosting');

    const observe = pairingIntent({ kind: 'browser', authority: 'observe' });
    assert(observe.authority === 'observe', 'browser view pairing is observe');
    assert(observe.grantExpiresAt(1_000) === 1_000 + 8 * 60 * 60_000, 'browser grants last eight hours');
    const record = observe.deviceRecord({
        deviceId: 'device-1',
        devicePublicKey: 'k',
        ingressKey: 'i',
        expiresAt: 1_000,
    });
    assert(record.deviceId === 'device-1', 'device id is the grant identity');
    assert(record.kind === 'browser', 'browser kind is recorded on the grant');
    assert(!('name' in record), 'display names never enter the grant record');

    const controlBrowser = pairingIntent({ kind: 'browser', authority: 'control' });
    assert(controlBrowser.authority === 'control', 'owner can grant browser control');
    assert(controlBrowser.promptLine().includes('control'), 'prompt names the authority');
    assert(!controlBrowser.personal, 'shared browser grants stay eight-hour by default');
    assert(controlBrowser.grantDurationLabel() === 'eight hours', 'default duration copy is eight hours');

    // Explicit personal-browser opt-in: longer renewable lifetime through the
    // same intent machinery, never inferred from install state.
    const personal = pairingIntent({ kind: 'browser', authority: 'control', personal: true });
    assert(personal.personal, 'personal opt-in is explicit');
    assert(personal.grantExpiresAt(1_000) === 1_000 + BROWSER_PERSONAL_GRANT_TTL_MS, 'personal grants last thirty days');
    assert(personal.grantDurationLabel() === '30 days', 'personal duration copy is thirty days');
    const personalRecord = personal.deviceRecord({ deviceId: 'device-9', devicePublicKey: 'k', ingressKey: 'i', expiresAt: 1_000 });
    assert(personalRecord.personal === true, 'personal marker rides the stored device record');
    assert(pairingIntentFromDevice({ kind: 'browser', authority: 'control', personal: true }).grantExpiresAt(1_000) === 1_000 + BROWSER_PERSONAL_GRANT_TTL_MS, 'stored personal marker restores the longer refresh clamp');
    assert(pairingIntentFromDevice({ kind: 'browser', authority: 'control' }).grantExpiresAt(1_000) === 1_000 + 8 * 60 * 60_000, 'stored shared grants keep the safe default');
    const flagPersonal = pairingIntentFromHostedFlags(['--browser-personal']);
    assert(flagPersonal.personal && flagPersonal.kind === 'browser' && flagPersonal.authority === 'control', '--browser-personal mints an explicit personal control grant');
    const flagDefault = pairingIntentFromHostedFlags(['--browser']);
    assert(!flagDefault.personal && flagDefault.grantDurationLabel() === 'eight hours', '--browser keeps the eight-hour default');
    assert(!personal.matchesPending({ deviceKind: 'browser', authority: 'control' }), 'personal intent never reuses a shared pending session');
    assert(!controlBrowser.matchesPending({ deviceKind: 'browser', authority: 'control', personal: true }), 'shared intent never reuses a personal pending session');
    // Recovered pending sessions rebuild their intent from the stored record,
    // personal marker included — the consent copy must not fall back to 8h.
    const recoveredPending = { deviceKind: 'browser', authority: 'control', personal: true };
    const recoveredIntent = pairingIntent({ kind: recoveredPending.deviceKind, authority: recoveredPending.authority, personal: recoveredPending.personal });
    assert(recoveredIntent.grantDurationLabel() === '30 days', 'recovered personal pending keeps its consent copy');

    // The printed locator carries the computer's name for consent; unsafe or
    // oversized names are dropped rather than echoed, and the short shape
    // otherwise stays exactly pair (+ role/personal for browsers).
    const nativeLocator = new URL(native.pairingLocator('ws://127.0.0.1:8792', 'ABCDE-FGHIJ', 'Android-Cert'));
    assert(nativeLocator.searchParams.get('name') === 'Android-Cert' && [...nativeLocator.searchParams.keys()].join(',') === 'pair,name', 'native locator names the computer');
    const browserLocator = new URL(personal.pairingLocator('wss://relay.example.test', 'ABCDE-FGHIJ', "  Umer's   MacBook  "));
    assert(browserLocator.pathname === '/pair' && [...browserLocator.searchParams.keys()].join(',') === 'pair,role,personal,name' && browserLocator.searchParams.get('name') === "Umer's MacBook", 'browser locator carries role, lifetime and a collapsed name');
    assert(consentMachineName('evil\u202edrocer') === undefined && consentMachineName('a@b') === undefined && consentMachineName('') === undefined, 'control, bidi and userinfo-like names are dropped');
    assert(consentMachineName('x'.repeat(80))?.length === 40, 'names are bounded');
    assert(!new URL(native.pairingLocator('ws://127.0.0.1:8792', 'ABCDE-FGHIJ', 'bad\u0007name')).searchParams.has('name'), 'an unsafe name is omitted, never echoed');

    const enrollment = parseEnrollment('not-a-link');
    assert(!enrollment.ok, 'malformed enrollment is rejected');

    assert(!validMachineCrypto(null, 'selfhost'), 'missing crypto is rejected');
    assert(!parseMachineCrypto({ signingPublicKey: 'nope' }, 'hosted').ok, 'truncated keys are rejected');
    const futureDevice = parseDevice({
        deviceId: 'device-future',
        devicePublicKey: Buffer.alloc(32).toString('base64'),
        ingressKey: Buffer.alloc(32).toString('base64'),
        expiresAt: new Date(0).toISOString(),
        kind: 'future-device-kind',
        extension: { version: 2 },
    });
    assert(futureDevice.ok && futureDevice.value.kind === 'future-device-kind', 'unknown device kinds are skipped, not corruption');

    const remote = parseConnection({
        relayLocation: 'remote',
        connectionMode: 'tailscale',
        relayUrl: 'wss://relay.example',
        webEnabled: false,
    });
    assert(remote.ok, 'remote connection parses');
    assert(remote.value.isRemote, 'remote location is a first-class decision');
    assert(!remote.value.canEnableBrowserHosting(), 'a joined machine cannot enable browser hosting');
    const rejection = remote.value.rejectionForBrowserHosting();
    assert(rejection !== undefined && rejection.includes('shared-relay owner'), 'rejection names the owner');

    const localSecure = parseConnection({
        relayLocation: 'local',
        connectionMode: 'tailscale',
        relayUrl: 'wss://machine.tailnet.ts.net',
        relayPort: 8792,
        webEnabled: true,
    });
    assert(localSecure.ok && localSecure.value.canEnableBrowserHosting(), 'Tailscale Serve can host the browser');
    assert(localSecure.value.browserHostingReady(), 'webEnabled plus wss is ready');

    const cloudflare = parseConnection({
        connectionMode: 'cloudflare',
        relayUrl: 'wss://ephemeral.trycloudflare.com',
        relayPort: 8792,
    });
    assert(cloudflare.ok && !cloudflare.value.canEnableBrowserHosting(), 'quick Cloudflare URLs cannot host the browser');

    const advertised = advertisedUrlForMode({
        mode: 'lan',
        found: { lan: '192.168.1.8', tailscale: {} },
        port: 8792,
        web: false,
        tailscalePlanned: false,
    });
    assert(advertised === 'ws://192.168.1.8:8792', 'LAN advertise is owned by the connection mode');
}

runSelfCheck();
