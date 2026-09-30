import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
// Keep the wizard check independently runnable without the ingress lab or a
// packaged CLI. Only machine I/O is replaced; prompts and wizard decisions run.
if (process.argv.includes('--wizard-child')) {
    await checkWizard();
    process.exit(0);
}
const wizard = spawnSync(process.execPath, [
    '--experimental-test-module-mocks', import.meta.filename, '--wizard-child',
], { encoding: 'utf8', timeout: 15_000 });
assert.equal(wizard.status, 0, `${wizard.stdout}${wizard.stderr}`);
process.stdout.write(wizard.stdout);
if (process.argv.includes('--wizard')) process.exit(0);

const {
    classifyNetworkRoutes,
    cleanupManagedIngress,
    continueWithDirectTailscale,
    inspectTailscaleServeRoot,
    persistOwnedServeIngress,
    readSelfhostState,
    recommendedConnection,
    resolveAdvertise,
    selfhostArgsFromSetupPlan,
    tailscaleBin,
    tailscaleIngress,
} = await import('../../setup/index.mjs');

const scratch = mkdtempSync(join(tmpdir(), 'muxr-tailscale-'));
const fake = join(scratch, 'tailscale');
const log = join(scratch, 'tailscale.log');
const serveStatusFile = join(scratch, 'serve-status.json');
const originalPath = process.env.PATH;
const originalHome = process.env.HOME;
const originalMuxrHome = process.env.MUXR_HOME;
const originalPlatform = process.env.MUXR_PLATFORM;
// The fake keeps Serve's root state in a file, because reach re-inspects after
// every write: publishing must flip the root to ours, removal back to free.
const oursStatus = JSON.stringify({ Web: { 'dev.tailnet.ts.net:443': { Handlers: { '/': { Proxy: 'http://127.0.0.1:8792' } } } } });
const configure = (status, initialServeStatus = '{}', serveApply = ':', serveStatusExit = 0) => {
    writeFileSync(serveStatusFile, initialServeStatus);
    writeFileSync(fake, `#!/bin/sh
printf '%s\\n' "$*" >> ${JSON.stringify(log)}
case "$*" in
  "status --json") printf '%s' '${JSON.stringify(status)}' ;;
  "serve status --json") printf '%s' "$(cat ${JSON.stringify(serveStatusFile)})"; exit ${serveStatusExit} ;;
  "serve --yes --bg --https=443 http://127.0.0.1:8792") ${serveApply}; printf '%s' '${oursStatus}' > ${JSON.stringify(serveStatusFile)}; exit 0 ;;
  "serve --https=443 --set-path=/ off") printf '{}' > ${JSON.stringify(serveStatusFile)} ;;
  *) exit 1 ;;
esac
`);
    chmodSync(fake, 0o755);
};
const commandsSince = (offset) => (existsSync(log) ? readFileSync(log, 'utf8') : '').slice(offset);
process.env.PATH = `${scratch}:${originalPath}`;
process.env.MUXR_HOME = join(scratch, 'muxr-home');
try {
    const routes = classifyNetworkRoutes({
        docker0: [{ family: 'IPv4', internal: false, address: '172.17.0.1' }],
        vboxnet0: [{ family: 'IPv4', internal: false, address: '192.168.56.1' }],
        eno1: [{ family: 'IPv4', internal: false, address: '192.168.1.8' }],
        wt0: [{ family: 'IPv4', internal: false, address: '100.90.0.4' }],
        tailscale0: [{ family: 'IPv4', internal: false, address: '100.64.0.1' }],
    });
    assert.deepEqual(routes, {
        private: { address: '100.90.0.4', interface: 'wt0', provider: 'NetBird' },
        lan: '192.168.1.8',
    });
    assert.deepEqual(classifyNetworkRoutes({
        utun4: [{ family: 'IPv4', internal: false, address: '100.64.0.1' }],
        utun5: [{ family: 'IPv4', internal: false, address: '10.20.0.2' }],
    }, '100.64.0.1').private, { address: '10.20.0.2', interface: 'utun5', provider: 'private network' });
    const found = { tailscale: { connected: false }, private: routes.private, lan: routes.lan, cloudflared: { ok: false } };
    assert.equal(recommendedConnection(found, undefined, false, { status: 'inconclusive' }).mode, 'private');
    assert.equal(recommendedConnection(found, undefined, true, { status: 'inconclusive' }).mode, 'private');
    assert.equal(recommendedConnection({ ...found, private: undefined, cloudflared: { ok: true } }, undefined, false, { status: 'inconclusive' }).mode, 'lan');
    assert.equal(recommendedConnection({ ...found, private: undefined }, undefined, false, { status: 'inconclusive' }).mode, 'lan');
    const privateArgs = selfhostArgsFromSetupPlan({ mode: 'private', port: 8792, web: false, pairing: 'phone', found });
    assert.deepEqual(privateArgs.slice(-2), ['--advertise', 'ws://100.90.0.4:8792']);
    assert.equal((await resolveAdvertise(privateArgs, 8792)).url, 'ws://100.90.0.4:8792');
    assert.equal(recommendedConnection(found, { connectionMode: 'external', relayUrl: 'wss://relay.example', relayPort: 8792, relayHealthy: true, publicHealthy: true }, false, { status: 'free' }).mode, 'external');
    assert.equal(recommendedConnection({ ...found, tailscale: { connected: true } }, undefined, false, { status: 'inconclusive' }).mode, 'tailscale');
    assert.equal(recommendedConnection({ ...found, tailscale: { connected: true } }, undefined, false, { status: 'disabled' }).mode, 'tailscale-direct');
    assert.equal(recommendedConnection({ ...found, tailscale: { connected: true } }, undefined, false, { status: 'occupied' }).mode, 'tailscale-direct');

    configure({ Self: { DNSName: 'dev.tailnet.ts.net.', TailscaleIPs: ['100.64.0.1'] } });
    const ingress = await tailscaleIngress([]);
    assert.deepEqual(ingress, { dnsName: 'dev.tailnet.ts.net' });
    assert.deepEqual(await resolveAdvertise([], 8792, ingress), {
        url: 'wss://dev.tailnet.ts.net',
        note: 'Tailscale Serve (private tailnet HTTPS)',
        ingress: { kind: 'tailscale-serve', port: 8792, dnsName: 'dev.tailnet.ts.net', proxy: 'http://127.0.0.1:8792' },
    });

    const disabledNotice = 'Serve is not enabled on your tailnet.\nTo enable, visit: https://login.tailscale.com/f/serve-test';
    configure({ Self: { DNSName: 'dev.tailnet.ts.net.', TailscaleIPs: ['100.64.0.1'] } }, disabledNotice, 'exit 0', 1);
    const unavailable = await inspectTailscaleServeRoot(8792, 'dev.tailnet.ts.net');
    assert.equal(unavailable.status, 'disabled');
    assert.match(unavailable.reason, /Serve is not enabled.*login\.tailscale\.com.*direct Tailscale or LAN/s);

    configure({ Self: { DNSName: 'dev.tailnet.ts.net.', TailscaleIPs: ['100.64.0.1'] } }, 'not json');
    assert.equal((await inspectTailscaleServeRoot(8792, 'dev.tailnet.ts.net')).status, 'inconclusive');

    configure(
        { Self: { DNSName: 'dev.tailnet.ts.net.', TailscaleIPs: ['100.64.0.1'] } },
        '{}',
        `printf '%s\\n' '${disabledNotice.replaceAll("'", "'\\''")}' >&2; exec sleep 30`,
    );
    const blockedAt = Date.now();
    await assert.rejects(resolveAdvertise([], 8792, await tailscaleIngress([])), /Serve is not enabled.*login\.tailscale\.com.*direct Tailscale or LAN/s);
    assert.ok(Date.now() - blockedAt < 20_000, 'disabled Tailscale Serve left setup blocked');

    configure({ Self: { DNSName: 'dev.tailnet.ts.net.' } }, JSON.stringify({ TCP: { '443': { HTTPS: true } }, Web: { 'dev.tailnet.ts.net:443': { Handlers: { '/': { Proxy: 'http://127.0.0.1:9999' } } } } }));
    await assert.rejects(resolveAdvertise([], 8792, await tailscaleIngress([])), /already owned/);

    configure({ Self: { DNSName: 'dev.tailnet.ts.net.' } }, JSON.stringify({ Web: { 'other.tailnet.ts.net:8443': { Handlers: { '/': { Proxy: 'http://127.0.0.1:8792' } } } } }));
    assert.equal((await resolveAdvertise([], 8792, await tailscaleIngress([]))).url, 'wss://dev.tailnet.ts.net');

    configure({ Self: { TailscaleIPs: ['100.64.0.1'] } });
    await assert.rejects(tailscaleIngress([]), /MagicDNS/);

    configure({ Self: { DNSName: 'umers-macbook-air.tail@de54.ts.net.', TailscaleIPs: ['100.64.0.1'] } });
    await assert.rejects(tailscaleIngress([]), /invalid MagicDNS name/);

    configure({ Self: { DNSName: 'dev.tailnet.ts.net.', TailscaleIPs: ['100.64.0.1'] } });
    assert.equal(await tailscaleIngress(['--tailscale-direct']), undefined);
    const direct = await resolveAdvertise(['--tailscale-direct'], 8792, undefined);
    assert.equal(direct.url, 'ws://100.64.0.1:8792');
    await assert.rejects(resolveAdvertise(['--advertise', 'wss://user:pass@example.com'], 8792), /without credentials/);
    await assert.rejects(resolveAdvertise(['--advertise', 'wss://example.com/muxr'], 8792), /without credentials/);

    const occupied = JSON.stringify({ TCP: { '443': { HTTPS: true } }, Web: { 'dev.tailnet.ts.net:443': { Handlers: { '/': { Proxy: 'http://127.0.0.1:9999' } } } } });
    configure({ Self: { DNSName: 'dev.tailnet.ts.net.', TailscaleIPs: ['100.64.0.1'] } }, occupied);
    const beforeForeign = existsSync(log) ? readFileSync(log, 'utf8').length : 0;
    assert.equal((await inspectTailscaleServeRoot(8792, 'dev.tailnet.ts.net')).status, 'occupied');
    await assert.rejects(resolveAdvertise([], 8792, await tailscaleIngress([])), /already owned/);
    const recovered = continueWithDirectTailscale({ mode: 'tailscale', port: 8792, web: true, pairing: 'both' });
    const recoveredArgs = selfhostArgsFromSetupPlan({ ...recovered, found: { lan: '192.168.1.8' } });
    assert.equal(recoveredArgs.at(recoveredArgs.indexOf('--connection-mode') + 1), 'tailscale-direct');
    assert.ok(recoveredArgs.includes('--tailscale-direct'));
    assert.ok(!recoveredArgs.includes('--web'));
    assert.equal((await resolveAdvertise(recoveredArgs, 8792, await tailscaleIngress(recoveredArgs))).url, 'ws://100.64.0.1:8792');
    await cleanupManagedIngress({ version: 1 });
    await cleanupManagedIngress({ version: 1, ingress: { kind: 'tailscale-serve', port: 8792, dnsName: 'dev.tailnet.ts.net', proxy: 'http://127.0.0.1:8792' } });
    assert.doesNotMatch(commandsSince(beforeForeign), /serve --yes|serve --https=443 --set-path=\/ off/, 'foreign Serve owner was claimed or reset');

    configure({ Self: { DNSName: 'dev.tailnet.ts.net.', TailscaleIPs: ['100.64.0.1'] } });
    const beforeClaim = readFileSync(log, 'utf8').length;
    const owned = await resolveAdvertise([], 8792, await tailscaleIngress([]));
    persistOwnedServeIngress({ version: 1 }, owned.ingress);
    assert.equal(readSelfhostState().ingress.proxy, 'http://127.0.0.1:8792');
    assert.match(commandsSince(beforeClaim), /serve --yes --bg --https=443 http:\/\/127\.0\.0\.1:8792/);
    configure({ Self: { DNSName: 'dev.tailnet.ts.net.', TailscaleIPs: ['100.64.0.1'] } }, oursStatus);
    await cleanupManagedIngress(readSelfhostState());
    assert.match(commandsSince(beforeClaim), /serve --https=443 --set-path=\/ off/);
    configure({ Self: { DNSName: 'dev.tailnet.ts.net.', TailscaleIPs: ['100.64.0.1'] } });
    const beforeGone = readFileSync(log, 'utf8').length;
    await cleanupManagedIngress(readSelfhostState());
    assert.doesNotMatch(commandsSince(beforeGone), /serve --https=443 --set-path=\/ off/, 'owned cleanup ran again after Serve was already gone');
    configure({ Self: { DNSName: 'dev.tailnet.ts.net.', TailscaleIPs: ['100.64.0.1'] } }, occupied);
    const beforeStale = readFileSync(log, 'utf8').length;
    await cleanupManagedIngress(readSelfhostState());
    assert.doesNotMatch(commandsSince(beforeStale), /serve --https=443 --set-path=\/ off/, 'stale muxr ownership reset a later foreign Serve owner');

    const macHome = join(scratch, 'mac-home');
    const macApp = join(macHome, 'Applications', 'Tailscale.app', 'Contents', 'MacOS', 'Tailscale');
    mkdirSync(join(scratch, 'empty-path'));
    mkdirSync(join(macHome, 'Applications', 'Tailscale.app', 'Contents', 'MacOS'), { recursive: true });
    writeFileSync(macApp, `#!/bin/sh\n[ "$TAILSCALE_BE_CLI" = 1 ] || exit 2\nprintf '%s' '${JSON.stringify({ BackendState: 'Running', Self: { DNSName: 'mac.tailnet.ts.net.', TailscaleIPs: ['100.64.0.2'] } })}'\n`, { mode: 0o755 });
    process.env.PATH = join(scratch, 'empty-path');
    process.env.HOME = macHome;
    process.env.MUXR_PLATFORM = 'darwin';
    assert.equal(tailscaleBin(), macApp, 'macOS app-bundled Tailscale CLI was not detected');
    assert.deepEqual(await tailscaleIngress([]), { dnsName: 'mac.tailnet.ts.net' });

    process.stdout.write('tailscale ingress ownership passed\n');
} finally {
    process.env.PATH = originalPath;
    if (originalHome === undefined) delete process.env.HOME; else process.env.HOME = originalHome;
    if (originalMuxrHome === undefined) delete process.env.MUXR_HOME; else process.env.MUXR_HOME = originalMuxrHome;
    if (originalPlatform === undefined) delete process.env.MUXR_PLATFORM; else process.env.MUXR_PLATFORM = originalPlatform;
    rmSync(scratch, { recursive: true, force: true });
}


async function checkWizard() {
    const { mock } = await import('node:test');
    const os = await import('node:os');
    const readline = await import('node:readline');
    const { EventEmitter } = await import('node:events');
    const scratch = mkdtempSync(join(process.cwd(), '.wizard-check-'));
    process.env.MUXR_HOME = join(scratch, 'state');
    process.env.HERDR_BIN = 'wizard-fixture-herdr';
    process.env.MUXR_NO_TUI = '1';
    process.env.NO_COLOR = '1';
    delete process.env.MUXR_RELAY_PORT;
    Object.defineProperty(process.stdin, 'isTTY', { value: true });
    Object.defineProperty(process.stdout, 'isTTY', { value: true });
    let lan;
    let tailscaleInstalled = true;
    let answers = [];
    let calls = [];
    let output = '';
    const write = process.stdout.write;
    process.stdout.write = (chunk) => { output += String(chunk); return true; };
    const boundary = (path, namedExports) => mock.module(new URL(path, import.meta.url).href, { namedExports });
    const record = (name, args) => { calls.push([name, args]); return 0; };
    const forbidden = () => { throw new Error('Unexpected setup side effect'); };
    try {
        mock.module('node:os', { namedExports: {
            userInfo: os.userInfo,
            networkInterfaces: () => lan ? { wifi: [{ family: 'IPv4', internal: false, address: lan }] } : {},
        } });
        mock.module('node:child_process', { namedExports: {
            spawnSync: (name, args) => {
                assert.ok(['wizard-fixture-herdr', 'cloudflared'].includes(name), `Unexpected command: ${name}`);
                if (name === 'cloudflared') return { status: null, error: { code: 'ENOENT' } };
                assert.ok(['--version', 'integration status'].includes(args.join(' ')));
                return { status: 0, stdout: args[0] === '--version' ? 'herdr fixture' : 'pi: not installed', stderr: '' };
            },
        } });
        mock.module('node:readline', { namedExports: {
            emitKeypressEvents: readline.emitKeypressEvents,
            createInterface: () => Object.assign(new EventEmitter(), {
                question: (message, reply) => {
                    assert.ok(answers.length, `Unexpected prompt: ${message}`);
                    process.stdout.write(message);
                    queueMicrotask(() => reply(answers.shift()));
                },
                close() {},
            }),
        } });
        boundary('../../setup/infrastructure/runtime.mjs', { relayPortFromEnv: () => undefined });
        boundary('../../setup/infrastructure/herdr.mjs', {
            herdrServerIsReady: () => true,
            runLocalPrerequisites: async (args) => record('prerequisites', args),
        });
        boundary('../../setup/infrastructure/selfhost.mjs', {
            runTailscale: (args) => {
                assert.deepEqual(args, ['status', '--json']);
                if (!tailscaleInstalled) return { status: null, error: { code: 'ENOENT' } };
                return { status: 0, stdout: JSON.stringify({ BackendState: 'NeedsLogin' }) };
            },
            inspectTailscaleServeRoot: forbidden,
            tailscaleBin: forbidden,
            selfhostPath: () => join(scratch, 'state', 'selfhost.json'),
        });
        boundary('../../setup/infrastructure/selfhostRelay.mjs', {
            selfhostPublicSummary: async () => undefined,
            sharedMachineCount: forbidden,
        });
        boundary('../../setup/application/startSelfHost.mjs', {
            startSelfHost: async (args) => record('start', args),
        });
        boundary('../../setup/application/pairDevice.mjs', {
            pairDevice: async (args) => record('pair', args),
        });
        boundary('../../setup/application/inspectSetup.mjs', { inspectSetup: async () => record('inspect') });
        boundary('../../setup/application/approveScreenSharing.mjs', { approveScreenSharing: async () => record('screen') });
        for (const [file, name] of [
            ['connectEnrollment', 'connectEnrollment'], ['enrollMachine', 'enrollMachine'],
            ['listMachines', 'listMachines'], ['revokeMachine', 'revokeMachine'],
        ]) boundary(`../../setup/application/${file}.mjs`, { [name]: forbidden });
        const { applyMachineSetup } = await import('../../setup/presentation/setupWizard.mjs');
        const run = async (input, args = []) => {
            answers = [...input];
            calls = [];
            output = '';
            assert.equal(await applyMachineSetup(args), 0);
            assert.deepEqual(answers, [], 'Wizard skipped an expected prompt');
            return output;
        };
        const recommended = (transcript, title) => {
            const lines = transcript.split('\n').filter((line) => line.includes('· Recommended'));
            assert.equal(lines.length, 1, 'Route picker must emit exactly one recommendation');
            assert.ok(lines[0].includes(title), `Expected ${title}: ${lines[0]}`);
        };

        // Accept the picker default, then cancel at review: signed-out
        // Tailscale must lose to ready Wi-Fi, but win when Wi-Fi is absent.
        lan = '192.168.1.8';
        recommended(await run(['', '1', '1']), 'Same Wi-Fi');
        assert.deepEqual(calls, [], 'Cancellation mutated setup');
        lan = undefined;
        recommended(await run(['', '1', '1', '1']), 'Tailscale — works anywhere');
        assert.deepEqual(calls, [], 'Planned Tailscale connected before Apply');

        // With no local route, accept the recommended external server and
        // complete Apply, phone + browser pairing, and the final receipt.
        tailscaleInstalled = false;
        const completed = await run(['', 'wss://relay.example', '2', '4', '1', '2']);
        recommended(completed, 'Your own server');
        assert.deepEqual([...completed.matchAll(/Setup step (\d+) of (\d+)/g)].map((match) => match.slice(1)),
            ['1', '2', '3', '4', '5', '6', '7'].map((step) => [step, '7']));
        assert.match(completed, /Setup complete/);
        assert.match(completed, /Pairing: phone and control browser paired/);
        assert.deepEqual(calls.map(([name]) => name), ['prerequisites', 'start', 'screen', 'pair', 'inspect']);
        assert.deepEqual(calls.find(([name]) => name === 'pair')[1], ['--browser']);
        assert.deepEqual(calls.find(([name]) => name === 'start')[1], [
            '--port', '8792', '--connection-mode', 'external', '--reconfigure',
            '--advertise', 'wss://relay.example', '--web', '--yes',
        ]);

        const inspection = await run([], ['--inspect']);
        assert.match(inspection, /Agent status updates not configured yet — setup can keep agent status up to date/);
        assert.doesNotMatch(inspection, /0 detected/);
        assert.deepEqual(calls, [], 'Inspection mutated setup');
    } finally {
        process.stdout.write = write;
        mock.restoreAll();
        rmSync(scratch, { recursive: true, force: true });
    }
    process.stdout.write('setup wizard: signed-out routes, external fallback, completed steps, and empty agent status passed\n');
}
