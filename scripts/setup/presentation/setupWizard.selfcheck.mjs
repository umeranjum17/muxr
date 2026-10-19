import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { basename, join } from 'node:path';

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
    let cloudflaredOk = false;
    let currentSummary;
    let agentStatus = 'pi: not installed';
    let presentAgentBins = [];
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
            Self: tailscaleConnected ? { DNSName: 'laptop.tailnet.ts.net.', TailscaleIPs: ['100.64.0.8'] } : {},
        }), stderr: '' };
        assert.deepEqual(args, ['serve', 'status', '--json']);
        if (serveStatus === 'disabled') return { status: 1, stdout: '', stderr: 'Serve is not enabled on your tailnet' };
        return { status: 0, stdout: JSON.stringify(serveStatus === 'occupied' ? {
            Web: { 'laptop.tailnet.ts.net:443': { Handlers: { '/': { Proxy: 'http://127.0.0.1:9999' } } } },
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
                if (name === 'cloudflared') return cloudflaredOk ? { status: 0, stdout: 'cloudflared fixture', stderr: '' } : { status: null, error: { code: 'ENOENT' } };
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
                    // An answer may first change the machine, as a person does
                    // between screens.
                    const next = answers.shift();
                    queueMicrotask(() => reply(typeof next === 'function' ? next() : next));
                },
                close() {},
            }),
        } });
        // The coding-agent probe scans PATH with accessSync; nothing else in
        // the exercised setup path uses it, so it alone is simulated here.
        const fs = await import('node:fs');
        mock.module('node:fs', { defaultExport: { ...fs }, namedExports: {
            ...fs,
            accessSync: (path) => {
                if (typeof path === 'string' && presentAgentBins.includes(basename(path))) return undefined;
                throw Object.assign(new Error(`ENOENT: no such file or directory, access '${path}'`), { code: 'ENOENT' });
            },
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
        const recommended = (transcript, title, count = 1) => {
            const lines = transcript.split('\n').filter((line) => line.includes('· Recommended'));
            assert.equal(lines.length, count, 'Route picker must emit exactly one recommendation per screen');
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
        // The first screen leads with the single recommended route; the rest
        // wait behind Other ways.
        assert.ok(connected.includes('Other ways'));
        for (const title of ['Use muxr away from home — phone only (Tailscale)', 'Use muxr away from home (private network)', 'Works only on this Wi-Fi', 'Use muxr away from home (temporary link)', 'Use muxr away from home (your own server)']) {
            assert.ok(!connected.includes(title), `Route leaked past Other ways: ${title}`);
        }
        // Through Other ways the hidden routes are all reachable, and leaving
        // by the same route review mutates nothing.
        const alternatives = await run(['2', '2', '1', '1']);
        recommended(alternatives, 'Use muxr away from home (Tailscale)', 2);
        for (const title of ['Use muxr away from home — phone only (Tailscale)', 'Use muxr away from home (private network)', 'Works only on this Wi-Fi', 'Use muxr away from home (temporary link)', 'Use muxr away from home (your own server)']) {
            assert.ok(alternatives.includes(title), `Missing route behind Other ways: ${title}`);
        }
        assert.match(alternatives, /Connection: Wi-Fi-only route on port/);
        assert.deepEqual(calls, [], 'Other ways cancellation mutated setup');
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
        tailscaleConnected = true;
        const connectedPlain = await run(['2', 'b', 'b']);
        assert.doesNotMatch(connectedPlain, /Works only on this Wi-Fi/);
        tailscaleConnected = false;

        // A first run reviews on the route screen: the plan sits under the
        // routes and cancelling there changes nothing. An installed Tailscale
        // that connects during Apply beats ready Wi-Fi, so the Wi-Fi-only
        // route is the default only when nothing remote-reachable exists.
        lan = '192.168.1.8';
        const firstCancel = await run(['b']);
        recommended(firstCancel, 'Use muxr away from home (Tailscale)');
        // First run skips the browser-client, pairing, and status-updates
        // questions and the separate review: check, then route.
        assert.deepEqual([...firstCancel.matchAll(/Setup step (\d+) of (\d+)/g)].map((match) => match.slice(1)),
            ['1', '2'].map((step) => [step, '3']));
        assert.match(firstCancel, /Other ways[\s\S]*We will use the Herdr already on this computer\.[\s\S]*Press Enter to apply this setup\.[\s\S]*Choose 1-2 \(1\)/);
        assert.doesNotMatch(firstCancel, /Review setup|Apply this setup\?|Host the browser client too/);
        assert.deepEqual(calls, [], 'Cancellation mutated setup');
        lan = undefined;
        const plannedCancel = await run(['b']);
        recommended(plannedCancel, 'Use muxr away from home (Tailscale)');
        assert.deepEqual([...plannedCancel.matchAll(/Setup step (\d+) of (\d+)/g)].map((match) => match.slice(1)),
            ['1', '2'].map((step) => [step, '3']));
        assert.deepEqual(calls, [], 'Planned Tailscale connected before Apply');

        // Without Tailscale the route screen says so in one sentence and
        // checks again in place (Other ways goes back to it): install it,
        // Enter, and Tailscale is the preselected route; one more Enter
        // applies it with the first-run defaults and no second confirmation.
        tailscaleInstalled = false;
        cloudflaredOk = true;
        lan = '192.168.1.8';
        const installed = await run(['2', 'b', () => { tailscaleInstalled = true; tailscaleConnected = true; return ''; }, '']);
        assert.match(installed, /Check again[\s\S]*Tailscale isn't on this computer yet\. Install it from https:\/\/tailscale\.com\/download and sign in, then press Enter to check again\.[\s\S]*Use muxr away from home \(Tailscale\) · Recommended/);
        recommended(installed, 'Use muxr away from home (Tailscale)');
        assert.doesNotMatch(installed, /Apply this setup\?/);
        assert.deepEqual([...installed.matchAll(/Setup step (\d+) of (\d+)/g)].map((match) => match.slice(1)),
            ['1', '2', '2', '2', '2', '3'].map((step) => [step, '3']));
        assert.deepEqual(calls.find(([name]) => name === 'start')[1].slice(0, 4), ['--port', '18792', '--connection-mode', 'tailscale']);
        tailscaleInstalled = false;
        tailscaleConnected = false;
        cloudflaredOk = false;

        // A computer already saved on its own server is not plain: Wi-Fi only
        // stays out of Other ways even with no Tailscale installed.
        currentSummary = {
            relayHealthy: true, publicHealthy: true, connectionMode: 'external',
            relayUrl: 'wss://relay.example', relayPort: 18792,
        };
        const savedAway = await run(['2', 'b', 'b']);
        assert.match(savedAway, /Other ways[\s\S]*Use muxr away from home \(your own server\)/);
        assert.doesNotMatch(savedAway, /Works only on this Wi-Fi/);
        assert.deepEqual(calls, [], 'Cancellation mutated setup');
        currentSummary = {
            relayHealthy: true, publicHealthy: true, connectionMode: undefined,
            relayUrl: 'wss://relay.example', relayPort: 18792,
        };
        const savedNoMode = await run(['2', 'b', 'b']);
        assert.doesNotMatch(savedNoMode, /Works only on this Wi-Fi/);
        assert.deepEqual(calls, [], 'Cancellation mutated setup');
        currentSummary = undefined;

        // A plain computer (no Tailscale, tunnel or server) is recommended
        // Wi-Fi only, so one Enter ends setup on it, with the note that the
        // phone must stay on that Wi-Fi.
        const plain = await run(['']);
        recommended(plain, 'Works only on this Wi-Fi');
        assert.match(plain, /Your phone must stay on this same Wi-Fi/);
        assert.deepEqual(calls.find(([name]) => name === 'start')[1].slice(0, 4), ['--port', '18792', '--connection-mode', 'lan']);

        // Your own server stays behind Other ways: the address applies with no
        // second confirmation, then the plain final receipt.
        const completed = await run(['2', '6', 'wss://relay.example']);
        assert.match(completed, /Other ways[\s\S]*Use muxr away from home \(your own server\)/);
        lan = undefined;
        assert.deepEqual([...completed.matchAll(/Setup step (\d+) of (\d+)/g)].map((match) => match.slice(1)),
            ['1', '2', '2', '3'].map((step) => [step, '3']));
        assert.doesNotMatch(completed, /Apply this setup\?/);
        assert.match(completed, /Setup complete/);
        assert.match(completed, /Your phone reaches this computer over/);
        assert.match(completed, /Open muxr on your phone and tap Start/);
        assert.deepEqual(calls.map(([name]) => name), ['prerequisites', 'start', 'screen', 'inspect']);
        assert.deepEqual(calls.find(([name]) => name === 'start')[1], [
            '--port', '18792', '--connection-mode', 'external', '--reconfigure',
            '--advertise', 'wss://relay.example',
        ]);
        // The hidden status-updates question counts as declined.
        assert.deepEqual(calls.find(([name]) => name === 'prerequisites')[1], ['--no-integrations']);

        // A provider installed means the question stays on a repeat run: it is
        // asked inside the pairing step, so the run still has six steps.
        // (First runs always skip it and keep the phone default.)
        agentStatus = 'pi: current';
        currentSummary = {
            relayHealthy: true, publicHealthy: true, connectionMode: 'lan',
            relayUrl: 'ws://192.168.1.8:18792', relayPort: 18792,
        };
        // A computer already on Wi-Fi only keeps that route behind Other ways.
        const providers = await run(['2', '6', 'wss://relay2.example', '2', '2', '1', '1']);
        assert.match(providers, /Other ways[\s\S]*Works only on this Wi-Fi · current/);
        assert.match(providers, /Keep agent status up to date\?/);
        assert.deepEqual([...providers.matchAll(/Setup step (\d+) of (\d+)/g)].map((match) => match.slice(1)),
            ['1', '2', '2', '3', '4', '5'].map((step) => [step, '6']));
        assert.deepEqual(calls, [], 'Cancellation mutated setup');
        agentStatus = 'pi: not installed';
        currentSummary = undefined;

        const inspection = await run([], ['--inspect']);
        assert.match(inspection, /Agent status updates not configured yet — setup can keep agent status up to date/);
        assert.doesNotMatch(inspection, /0 detected/);
        assert.deepEqual(calls, [], 'Inspection mutated setup');

        // No agent binary on PATH: setup names the gap with an install command.
        assert.match(inspection, /No coding agent found\. Install one, e\.g\. `npm i -g @anthropic-ai\/claude-code`, then sign in/);

        // Agent binaries present: setup lists them instead of warning.
        presentAgentBins = ['claude', 'codex'];
        const agentsFound = await run([], ['--inspect']);
        assert.match(agentsFound, /Coding agents 2 found — claude, codex/);
        assert.doesNotMatch(agentsFound, /No coding agent found/);
        assert.deepEqual(calls, [], 'Inspection mutated setup');
        presentAgentBins = [];
    } finally {
        process.stdout.write = write;
        mock.restoreAll();
        rmSync(scratch, { recursive: true, force: true });
    }
    process.stdout.write('setup wizard: connected/blocked/signed-out routes, external fallback, cancellation, completed steps, hidden status question, and empty agent status passed\n');
}
