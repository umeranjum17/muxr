import { advertisedUrlForMode, parseConnection } from './connection.js';
import { parseEnrollment } from './enrollment.js';
import { parseDevice, parseMachineCrypto, validMachineCrypto } from './machineCrypto.js';
import { pairingIntent } from './pairing.js';

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
