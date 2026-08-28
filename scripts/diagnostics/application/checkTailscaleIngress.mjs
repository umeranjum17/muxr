import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveAdvertise, tailscaleBin, tailscaleIngress } from '../../setup/index.mjs';

const scratch = mkdtempSync(join(tmpdir(), 'muxr-tailscale-'));
const fake = join(scratch, 'tailscale');
const originalPath = process.env.PATH;
const originalHome = process.env.HOME;
const originalPlatform = process.env.MUXR_PLATFORM;
const configure = (status, serveStatus = '{}') => {
    writeFileSync(fake, `#!/bin/sh\ncase "$*" in\n  "status --json") printf '%s' '${JSON.stringify(status)}' ;;\n  "serve status --json") printf '%s' '${serveStatus.replaceAll("'", "'\\''")}' ;;\n  "serve --yes --bg --https=443 http://127.0.0.1:8792") exit 0 ;;\n  *) exit 1 ;;\nesac\n`);
    chmodSync(fake, 0o755);
};
process.env.PATH = `${scratch}:${originalPath}`;
try {
    configure({ Self: { DNSName: 'dev.tailnet.ts.net.', TailscaleIPs: ['100.64.0.1'] } });
    const ingress = tailscaleIngress([]);
    assert.deepEqual(ingress, { dnsName: 'dev.tailnet.ts.net' });
    assert.deepEqual(await resolveAdvertise([], 8792, ingress), {
        url: 'wss://dev.tailnet.ts.net',
        note: 'Tailscale Serve (private tailnet HTTPS)',
        ingress: { kind: 'tailscale-serve', port: 8792, dnsName: 'dev.tailnet.ts.net' },
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
    if (originalPlatform === undefined) delete process.env.MUXR_PLATFORM; else process.env.MUXR_PLATFORM = originalPlatform;
}
