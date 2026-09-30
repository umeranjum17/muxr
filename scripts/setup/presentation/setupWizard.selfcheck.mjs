import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';

// Run with --experimental-test-module-mocks. Only machine I/O is replaced;
// prompts and wizard decisions run through the real presentation modules.
await checkWizard();

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
        boundary('../infrastructure/runtime.mjs', { relayPortFromEnv: () => undefined });
        boundary('../infrastructure/herdr.mjs', {
            herdrServerIsReady: () => true,
            runLocalPrerequisites: async (args) => record('prerequisites', args),
        });
        boundary('../infrastructure/selfhost.mjs', {
            runTailscale: (args) => {
                assert.deepEqual(args, ['status', '--json']);
                if (!tailscaleInstalled) return { status: null, error: { code: 'ENOENT' } };
                return { status: 0, stdout: JSON.stringify({ BackendState: 'NeedsLogin' }) };
            },
            inspectTailscaleServeRoot: forbidden,
            tailscaleBin: forbidden,
            selfhostPath: () => join(scratch, 'state', 'selfhost.json'),
        });
        boundary('../infrastructure/selfhostRelay.mjs', {
            selfhostPublicSummary: async () => undefined,
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
