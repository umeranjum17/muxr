import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveAdvertise, tailscaleIngress } from './local-setup.mjs';

const scratch = mkdtempSync(join(tmpdir(), 'muxr-tailscale-'));
const fake = join(scratch, 'tailscale');
const originalPath = process.env.PATH;
const configure = (status, serveStatus = '{}') => {
    writeFileSync(fake, `#!/bin/sh\ncase "$*" in\n  "status --json") printf '%s' '${JSON.stringify(status)}' ;;\n  "serve status --json") printf '%s' '${serveStatus.replaceAll("'", "'\\''")}' ;;\n  "serve --bg --https=443 http://127.0.0.1:8792") exit 0 ;;\n  *) exit 1 ;;\nesac\n`);
    chmodSync(fake, 0o755);
};
process.env.PATH = `${scratch}:${originalPath}`;
try {
    configure({ Self: { DNSName: 'dev.tailnet.ts.net.', TailscaleIPs: ['100.64.0.1'] } });
    const ingress = tailscaleIngress([]);
    assert.deepEqual(ingress, { dnsName: 'dev.tailnet.ts.net' });
    assert.deepEqual(await resolveAdvertise([], 8792, ingress), {
        url: 'wss://dev.tailnet.ts.net', note: 'Tailscale Serve (private tailnet HTTPS)',
    });

    configure({ Self: { DNSName: 'dev.tailnet.ts.net.' } }, JSON.stringify({ TCP: { '443': { HTTPS: true } }, Web: { 'dev.tailnet.ts.net:443': { Handlers: { '/': { Proxy: 'http://127.0.0.1:9999' } } } } }));
    await assert.rejects(resolveAdvertise([], 8792, tailscaleIngress([])), /already owned/);

    configure({ Self: { TailscaleIPs: ['100.64.0.1'] } });
    assert.throws(() => tailscaleIngress([]), /MagicDNS/);

    configure({ Self: { DNSName: 'dev.tailnet.ts.net.', TailscaleIPs: ['100.64.0.1'] } });
    assert.equal(tailscaleIngress(['--tailscale-direct']), undefined);
    const direct = await resolveAdvertise(['--tailscale-direct'], 8792, undefined);
    assert.equal(direct.url, 'ws://100.64.0.1:8792');
    process.stdout.write('tailscale ingress ownership passed\n');
} finally {
    process.env.PATH = originalPath;
}
