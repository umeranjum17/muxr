import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';

// Run with --experimental-test-module-mocks. Only machine I/O is replaced;
// prompts and wizard decisions run through the real presentation modules.
await checkWizard();

async function checkWizard() {
    const { mock } = await import('node:test');
    const os = await import('node:os');
    const childProcess = await import('node:child_process');
    const readline = await import('node:readline');
    const { EventEmitter } = await import('node:events');
    const scratch = mkdtempSync(join(process.cwd(), '.wizard-check-'));
    process.env.MUXR_HOME = join(scratch, 'state');
    process.env.HERDR_BIN = 'wizard-fixture-herdr';
    process.env.MUXR_TAILSCALE_BIN = 'wizard-fixture-tailscale';
    process.env.MUXR_NO_TUI = '1';
    process.env.NO_COLOR = '1';
    process.env.MUXR_RELAY_PORT = '18792';
    process.env.HOME = join(scratch, 'home');
    process.env.XDG_CONFIG_HOME = join(scratch, 'config');
    process.env.XDG_DATA_HOME = join(scratch, 'data');
    process.env.XDG_STATE_HOME = join(scratch, 'system-state');
    process.env.XDG_CACHE_HOME = join(scratch, 'cache');
    Object.defineProperty(process.stdin, 'isTTY', { value: true });
    Object.defineProperty(process.stdout, 'isTTY', { value: true });
    let lan;
    let currentSummary;
    let agentStatus = 'pi: not installed';
    let tailscaleInstalled = true;
    let tailscaleConnected = false;
    let serveStatus = 'free';
    let answers = [];
    let calls = [];
    let output = '';
    const write = process.stdout.write;
    process.stdout.write = (chunk) => { output += String(chunk); return true; };
    const boundary = (path, namedExports) => mock.module(new URL(path, import.meta.url).href, { namedExports });
    const record = (name, args) => { calls.push([name, args]); return 0; };
    const forbidden = () => { throw new Error('Unexpected setup side effect'); };
    const tailscaleCommand = (args) => {
        if (!tailscaleInstalled) return { status: null, error: { code: 'ENOENT' }, stdout: '', stderr: '' };
        if (args.join(' ') === 'status --json') return { status: 0, stdout: JSON.stringify({
            BackendState: tailscaleConnected ? 'Running' : 'NeedsLogin',
            Self: tailscaleConnected ? { DNSName: 'umer.tailnet.ts.net.', TailscaleIPs: ['100.64.0.8'] } : {},
        }), stderr: '' };
        assert.deepEqual(args, ['serve', 'status', '--json']);
        if (serveStatus === 'disabled') return { status: 1, stdout: '', stderr: 'Serve is not enabled on your tailnet' };
        return { status: 0, stdout: JSON.stringify(serveStatus === 'occupied' ? {
            Web: { 'umer.tailnet.ts.net:443': { Handlers: { '/': { Proxy: 'http://127.0.0.1:9999' } } } },
        } : {}), stderr: '' };
    };
    try {
        mock.module('node:os', { defaultExport: { ...os }, namedExports: {
            ...os,
            userInfo: () => ({ ...os.userInfo(), username: 'Umer', homedir: process.env.HOME }),
            networkInterfaces: () => lan ? { wifi: [{ family: 'IPv4', internal: false, address: lan }] } : {},
        } });
        mock.module('node:child_process', { defaultExport: { ...childProcess }, namedExports: {
            ...childProcess,
            execFile: (name, args, options, reply) => {
                assert.equal(name, 'wizard-fixture-tailscale');
                const result = tailscaleCommand(args);
                const error = result.error ?? (result.status === 0 ? null : { code: result.status });
                queueMicrotask(() => reply(error, result.stdout, result.stderr));
            },
            spawnSync: (name, args) => {
                if (name === 'wizard-fixture-tailscale') return tailscaleCommand(args);
                assert.ok(['wizard-fixture-herdr', 'cloudflared'].includes(name), `Unexpected command: ${name}`);
                if (name === 'cloudflared') return { status: null, error: { code: 'ENOENT' } };
                assert.ok(['--version', 'integration status'].includes(args.join(' ')));
                return { status: 0, stdout: args[0] === '--version' ? 'herdr fixture' : agentStatus, stderr: '' };
            },
        } });
        mock.module('node:readline', { defaultExport: { ...readline }, namedExports: {
            ...readline,
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
        boundary('../infrastructure/herdr.mjs', {
            herdrServerIsReady: () => true,
            runLocalPrerequisites: async (args) => record('prerequisites', args),
        });
        boundary('../infrastructure/selfhostRelay.mjs', {
            selfhostPublicSummary: async () => currentSummary,
            sharedMachineCount: forbidden,
        });
        boundary('../application/startSelfHost.mjs', {
            startSelfHost: async (args) => record('start', args),
        });
        boundary('../application/pairDevice.mjs', {
            pairDevice: async (args) => record('pair', args),
        });
        boundary('../application/inspectSetup.mjs', { inspectSetup: async () => record('inspect') });
        boundary('../application/approveScreenSharing.mjs', { approveScreenSharing: async () => record('screen') });
        for (const [file, name] of [
            ['connectEnrollment', 'connectEnrollment'], ['enrollMachine', 'enrollMachine'],
            ['listMachines', 'listMachines'], ['revokeMachine', 'revokeMachine'],
        ]) boundary(`../application/${file}.mjs`, { [name]: forbidden });
        const { applyMachineSetup } = await import('./setupWizard.mjs');
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

        // Connected Tailscale uses real Serve inspection; its blocked sibling
        // routes must select direct Tailscale without applying any changes,
        // even when the current LAN route remains healthy and selectable.
        lan = '192.168.1.8';
        currentSummary = {
            relayHealthy: true, publicHealthy: true, connectionMode: 'lan',
            relayUrl: 'ws://192.168.1.8:18792', relayPort: 18792,
        };
        tailscaleConnected = true;
        const connected = await run(['', '1', '1', '1']);
        recommended(connected, 'Use muxr away from home (Tailscale)');
        for (const title of ['Use muxr away from home (Tailscale)', 'Use muxr away from home — phone only (Tailscale)', 'Use muxr away from home (private network)', 'Works only on this Wi-Fi', 'Use muxr away from home (temporary link)', 'Use muxr away from home (your own server)']) {
            assert.ok(connected.includes(title), `Missing route: ${title}`);
        }
        assert.ok(connected.indexOf('Works only on this Wi-Fi') < connected.indexOf('Use muxr away from home (temporary link)'));
        // No providers installed: the status-updates question is hidden,
        // so a first run is five steps of six, not six of seven.
        assert.deepEqual([...connected.matchAll(/Setup step (\d+) of (\d+)/g)].map((match) => match.slice(1)),
            ['1', '2', '3', '4', '5'].map((step) => [step, '6']));
        assert.doesNotMatch(connected, /Keep agent status up to date/);
        assert.match(connected, /Connection: Tailscale/);
        assert.deepEqual(calls, [], 'Cancellation mutated setup');
        for (const blocked of ['occupied', 'disabled']) {
            serveStatus = blocked;
            const direct = await run(['', '1', '1']);
            recommended(direct, 'Use muxr away from home — phone only (Tailscale)');
            assert.match(direct, /Connection: Direct Tailscale on port 18792/);
            assert.deepEqual(calls, [], 'Blocked Serve mutated setup');
        }
        tailscaleConnected = false;
        serveStatus = 'free';
        currentSummary = undefined;

        // Accept the picker default, then cancel at review: an installed
        // Tailscale that connects during Apply beats ready Wi-Fi, so the
        // Wi-Fi-only route is the default only when nothing remote-reachable
        // exists.
        lan = '192.168.1.8';
        recommended(await run(['', '1', '1']), 'Use muxr away from home (Tailscale)');
        assert.deepEqual(calls, [], 'Cancellation mutated setup');
        lan = undefined;
        recommended(await run(['', '1', '1']), 'Use muxr away from home (Tailscale)');
        assert.deepEqual(calls, [], 'Planned Tailscale connected before Apply');

        // With no local route, accept the recommended external server and
        // complete Apply, phone + browser pairing, and the final receipt.
        tailscaleInstalled = false;
        const completed = await run(['', 'wss://relay.example', '2', '4', '2']);
        recommended(completed, 'Use muxr away from home (your own server)');
        assert.deepEqual([...completed.matchAll(/Setup step (\d+) of (\d+)/g)].map((match) => match.slice(1)),
            ['1', '2', '3', '4', '5', '6'].map((step) => [step, '6']));
        assert.match(completed, /Setup complete/);
        assert.match(completed, /Pairing: phone and control browser paired/);
        assert.deepEqual(calls.map(([name]) => name), ['prerequisites', 'start', 'screen', 'pair', 'inspect']);
        assert.deepEqual(calls.find(([name]) => name === 'pair')[1], ['--browser']);
        assert.deepEqual(calls.find(([name]) => name === 'start')[1], [
            '--port', '18792', '--connection-mode', 'external', '--reconfigure',
            '--advertise', 'wss://relay.example', '--web', '--yes',
        ]);
        // The hidden status-updates question counts as declined.
        assert.deepEqual(calls.find(([name]) => name === 'prerequisites')[1], ['--no-integrations']);

        // A provider installed means the question stays: seven steps, and
        // the run answers it before cancelling at review.
        agentStatus = 'pi: current';
        const providers = await run(['', 'wss://relay2.example', '2', '4', '1', '1']);
        assert.match(providers, /Keep agent status up to date\?/);
        assert.deepEqual([...providers.matchAll(/Setup step (\d+) of (\d+)/g)].map((match) => match.slice(1)),
            ['1', '2', '3', '4', '5', '6'].map((step) => [step, '7']));
        assert.deepEqual(calls, [], 'Cancellation mutated setup');
        agentStatus = 'pi: not installed';

        const inspection = await run([], ['--inspect']);
        assert.match(inspection, /Agent status updates not configured yet — setup can keep agent status up to date/);
        assert.doesNotMatch(inspection, /0 detected/);
        assert.deepEqual(calls, [], 'Inspection mutated setup');
    } finally {
        process.stdout.write = write;
        mock.restoreAll();
        rmSync(scratch, { recursive: true, force: true });
    }
    process.stdout.write('setup wizard: connected/blocked/signed-out routes, external fallback, cancellation, completed steps, hidden status question, and empty agent status passed\n');
}
