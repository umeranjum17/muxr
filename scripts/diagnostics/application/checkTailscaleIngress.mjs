import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
    cleanupManagedIngress,
    continueWithDirectTailscale,
    inspectTailscaleServeRoot,
    persistOwnedServeIngress,
    readSelfhostState,
    resolveAdvertise,
    selfhostArgsFromSetupPlan,
    tailscaleBin,
    tailscaleIngress,
} from '../../setup/index.mjs';

const scratch = mkdtempSync(join(tmpdir(), 'muxr-tailscale-'));
const fake = join(scratch, 'tailscale');
const log = join(scratch, 'tailscale.log');
const originalPath = process.env.PATH;
const originalHome = process.env.HOME;
const originalMuxrHome = process.env.MUXR_HOME;
const originalPlatform = process.env.MUXR_PLATFORM;
const configure = (status, serveStatus = '{}') => {
    writeFileSync(fake, `#!/bin/sh\nprintf '%s\\n' "$*" >> ${JSON.stringify(log)}\ncase "$*" in\n  "status --json") printf '%s' '${JSON.stringify(status)}' ;;\n  "serve status --json") printf '%s' '${serveStatus.replaceAll("'", "'\\''")}' ;;\n  "serve --yes --bg --https=443 http://127.0.0.1:8792") exit 0 ;;\n  "serve --https=443 off") exit 0 ;;\n  *) exit 1 ;;\nesac\n`);
    chmodSync(fake, 0o755);
};
const commandsSince = (offset) => (existsSync(log) ? readFileSync(log, 'utf8') : '').slice(offset);
process.env.PATH = `${scratch}:${originalPath}`;
process.env.MUXR_HOME = join(scratch, 'muxr-home');
try {
    configure({ Self: { DNSName: 'dev.tailnet.ts.net.', TailscaleIPs: ['100.64.0.1'] } });
    const ingress = tailscaleIngress([]);
    assert.deepEqual(ingress, { dnsName: 'dev.tailnet.ts.net' });
    assert.deepEqual(await resolveAdvertise([], 8792, ingress), {
        url: 'wss://dev.tailnet.ts.net',
        note: 'Tailscale Serve (private tailnet HTTPS)',
        ingress: { kind: 'tailscale-serve', port: 8792, dnsName: 'dev.tailnet.ts.net', proxy: 'http://127.0.0.1:8792' },
    });

    configure({ Self: { DNSName: 'dev.tailnet.ts.net.' } }, JSON.stringify({ TCP: { '443': { HTTPS: true } }, Web: { 'dev.tailnet.ts.net:443': { Handlers: { '/': { Proxy: 'http://127.0.0.1:9999' } } } } }));
    await assert.rejects(resolveAdvertise([], 8792, tailscaleIngress([])), /already owned/);

    configure({ Self: { DNSName: 'dev.tailnet.ts.net.' } }, JSON.stringify({ Web: { 'other.tailnet.ts.net:8443': { Handlers: { '/': { Proxy: 'http://127.0.0.1:8792' } } } } }));
    assert.equal((await resolveAdvertise([], 8792, tailscaleIngress([]))).url, 'wss://dev.tailnet.ts.net');

    configure({ Self: { TailscaleIPs: ['100.64.0.1'] } });
    assert.throws(() => tailscaleIngress([]), /MagicDNS/);

    configure({ Self: { DNSName: 'umers-macbook-air.tail@de54.ts.net.', TailscaleIPs: ['100.64.0.1'] } });
    assert.throws(() => tailscaleIngress([]), /invalid MagicDNS name/);

    configure({ Self: { DNSName: 'dev.tailnet.ts.net.', TailscaleIPs: ['100.64.0.1'] } });
    assert.equal(tailscaleIngress(['--tailscale-direct']), undefined);
    const direct = await resolveAdvertise(['--tailscale-direct'], 8792, undefined);
    assert.equal(direct.url, 'ws://100.64.0.1:8792');
    await assert.rejects(resolveAdvertise(['--advertise', 'wss://user:pass@example.com'], 8792), /without credentials/);
    await assert.rejects(resolveAdvertise(['--advertise', 'wss://example.com/muxr'], 8792), /without credentials/);

    const occupied = JSON.stringify({ TCP: { '443': { HTTPS: true } }, Web: { 'dev.tailnet.ts.net:443': { Handlers: { '/': { Proxy: 'http://127.0.0.1:9999' } } } } });
    const ours = JSON.stringify({ Web: { 'dev.tailnet.ts.net:443': { Handlers: { '/': { Proxy: 'http://127.0.0.1:8792' } } } } });
    configure({ Self: { DNSName: 'dev.tailnet.ts.net.', TailscaleIPs: ['100.64.0.1'] } }, occupied);
    const beforeForeign = existsSync(log) ? readFileSync(log, 'utf8').length : 0;
    assert.equal(inspectTailscaleServeRoot(8792, 'dev.tailnet.ts.net').status, 'occupied');
    await assert.rejects(resolveAdvertise([], 8792, tailscaleIngress([])), /already owned/);
    const recovered = continueWithDirectTailscale({ mode: 'tailscale', port: 8792, web: true, pairing: 'both' });
    const recoveredArgs = selfhostArgsFromSetupPlan({ ...recovered, found: { lan: '192.168.1.8' } });
    assert.equal(recoveredArgs.at(recoveredArgs.indexOf('--connection-mode') + 1), 'tailscale-direct');
    assert.ok(recoveredArgs.includes('--tailscale-direct'));
    assert.ok(!recoveredArgs.includes('--web'));
    assert.equal((await resolveAdvertise(recoveredArgs, 8792, tailscaleIngress(recoveredArgs))).url, 'ws://100.64.0.1:8792');
    cleanupManagedIngress({ version: 1 });
    cleanupManagedIngress({ version: 1, ingress: { kind: 'tailscale-serve', port: 8792, dnsName: 'dev.tailnet.ts.net', proxy: 'http://127.0.0.1:8792' } });
    assert.doesNotMatch(commandsSince(beforeForeign), /serve --yes|serve --https=443 off/, 'foreign Serve owner was claimed or reset');

    configure({ Self: { DNSName: 'dev.tailnet.ts.net.', TailscaleIPs: ['100.64.0.1'] } });
    const beforeClaim = readFileSync(log, 'utf8').length;
    const owned = await resolveAdvertise([], 8792, tailscaleIngress([]));
    persistOwnedServeIngress({ version: 1 }, owned.ingress);
    assert.equal(readSelfhostState().ingress.proxy, 'http://127.0.0.1:8792');
    assert.match(commandsSince(beforeClaim), /serve --yes --bg --https=443 http:\/\/127\.0\.0\.1:8792/);
    configure({ Self: { DNSName: 'dev.tailnet.ts.net.', TailscaleIPs: ['100.64.0.1'] } }, ours);
    cleanupManagedIngress(readSelfhostState());
    assert.match(commandsSince(beforeClaim), /serve --https=443 off/);
    configure({ Self: { DNSName: 'dev.tailnet.ts.net.', TailscaleIPs: ['100.64.0.1'] } });
    const beforeGone = readFileSync(log, 'utf8').length;
    cleanupManagedIngress(readSelfhostState());
    assert.doesNotMatch(commandsSince(beforeGone), /serve --https=443 off/, 'owned cleanup ran again after Serve was already gone');
    configure({ Self: { DNSName: 'dev.tailnet.ts.net.', TailscaleIPs: ['100.64.0.1'] } }, occupied);
    const beforeStale = readFileSync(log, 'utf8').length;
    cleanupManagedIngress(readSelfhostState());
    assert.doesNotMatch(commandsSince(beforeStale), /serve --https=443 off/, 'stale muxr ownership reset a later foreign Serve owner');

    const macHome = join(scratch, 'mac-home');
    const macApp = join(macHome, 'Applications', 'Tailscale.app', 'Contents', 'MacOS', 'Tailscale');
    mkdirSync(join(scratch, 'empty-path'));
    mkdirSync(join(macHome, 'Applications', 'Tailscale.app', 'Contents', 'MacOS'), { recursive: true });
    writeFileSync(macApp, `#!/bin/sh\n[ "$TAILSCALE_BE_CLI" = 1 ] || exit 2\nprintf '%s' '${JSON.stringify({ BackendState: 'Running', Self: { DNSName: 'mac.tailnet.ts.net.', TailscaleIPs: ['100.64.0.2'] } })}'\n`, { mode: 0o755 });
    process.env.PATH = join(scratch, 'empty-path');
    process.env.HOME = macHome;
    process.env.MUXR_PLATFORM = 'darwin';
    assert.equal(tailscaleBin(), macApp, 'macOS app-bundled Tailscale CLI was not detected');
    assert.deepEqual(tailscaleIngress([]), { dnsName: 'mac.tailnet.ts.net' });

    process.stdout.write('tailscale ingress ownership passed\n');
} finally {
    process.env.PATH = originalPath;
    if (originalHome === undefined) delete process.env.HOME; else process.env.HOME = originalHome;
    if (originalMuxrHome === undefined) delete process.env.MUXR_HOME; else process.env.MUXR_HOME = originalMuxrHome;
    if (originalPlatform === undefined) delete process.env.MUXR_PLATFORM; else process.env.MUXR_PLATFORM = originalPlatform;
}
