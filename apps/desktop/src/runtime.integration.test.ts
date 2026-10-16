/**
 * The desktop app owns the relay and host only for the state it wrote itself.
 * State from the command-line install means muxr already runs there, so the app
 * refuses with one plain state; only a desktop-created state starts processes.
 */
import { createHash } from 'node:crypto';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createHerdrSetup, wireHerdrToRuntime } from './herdrSetup.mjs';
import { MuxrRuntime, RelayOwnedError } from './runtime.mjs';

const MACHINE = { id: 'machine-owner', name: 'computer', crypto: { signingPublicKey: 's' } };

function appendingFixture(path: string, marker: string, logPath: string) {
    writeFileSync(path, [
        "import { appendFileSync } from 'node:fs';",
        `appendFileSync(${JSON.stringify(logPath)}, ${JSON.stringify(marker)} + String.fromCharCode(10));`,
        'setInterval(() => {}, 1000);',
        '',
    ].join('\n'));
}

function listeningRelayFixture(path: string) {
    writeFileSync(path, [
        "setTimeout(() => process.stdout.write('relay listening on ws://127.0.0.1:8792\\n'), 150);",
        'setInterval(() => {}, 1000);',
        '',
    ].join('\n'));
}

function collectingRuntime(home: string, relayEntry: string, hostEntry: string, node = process.execPath, stallMs?: number) {
    const statuses: { phase: string; message?: string; canRetry?: boolean }[] = [];
    const runtime = new MuxrRuntime({ home, node, relayEntry, hostEntry, port: 8792, ...(stallMs === undefined ? {} : { stallMs }) });
    runtime.on('status', (event) => statuses.push(event));
    return { runtime, statuses };
}

describe('desktop runtime self-host state', () => {
    it('refuses a CLI local state without starting the relay or host', async () => {
        const home = mkdtempSync(join(tmpdir(), 'muxr-desktop-cli-local-'));
        const before = `${JSON.stringify({ version: 1, machine: MACHINE, relayLocation: 'local', relayPort: 8792, bindHost: '127.0.0.1' })}\n`;
        writeFileSync(join(home, 'selfhost.json'), before, { mode: 0o600 });
        const spawnLog = join(home, 'spawns.log');
        const relayEntry = join(home, 'relay-fixture.mjs');
        appendingFixture(relayEntry, 'relay', spawnLog);
        const hostEntry = join(home, 'host-fixture.mjs');
        appendingFixture(hostEntry, 'host', spawnLog);

        const { runtime, statuses } = collectingRuntime(home, relayEntry, hostEntry);
        await expect(runtime.start()).rejects.toThrow(RelayOwnedError);

        expect(statuses.at(-1)?.phase).toBe('already-running');
        expect(statuses.at(-1)?.message).toContain('muxr pair');
        expect(statuses.at(-1)?.canRetry).toBe(false);
        expect(readFileSync(join(home, 'selfhost.json'), 'utf8')).toBe(before);
        expect(existsSync(spawnLog)).toBe(false);
    });

    it('refuses a CLI remote state without starting the relay or host', async () => {
        const home = mkdtempSync(join(tmpdir(), 'muxr-desktop-cli-remote-'));
        const before = `${JSON.stringify({ version: 1, machine: MACHINE, relayLocation: 'remote', relayUrl: 'wss://relay.example.test', connectionMode: 'shared' })}\n`;
        writeFileSync(join(home, 'selfhost.json'), before, { mode: 0o600 });
        const spawnLog = join(home, 'spawns.log');
        const relayEntry = join(home, 'relay-fixture.mjs');
        appendingFixture(relayEntry, 'relay', spawnLog);
        const hostEntry = join(home, 'host-fixture.mjs');
        appendingFixture(hostEntry, 'host', spawnLog);

        const { runtime, statuses } = collectingRuntime(home, relayEntry, hostEntry);
        await expect(runtime.start()).rejects.toThrow(RelayOwnedError);

        expect(statuses.at(-1)?.phase).toBe('already-running');
        expect(statuses.at(-1)?.message).toContain('muxr pair');
        expect(statuses.at(-1)?.canRetry).toBe(false);
        expect(readFileSync(join(home, 'selfhost.json'), 'utf8')).toBe(before);
        expect(existsSync(spawnLog)).toBe(false);
    });

    it('runs the relay and host for state the desktop created itself', async () => {
        const home = mkdtempSync(join(tmpdir(), 'muxr-desktop-own-'));
        writeFileSync(join(home, 'selfhost.json'), `${JSON.stringify({ version: 1, createdBy: 'desktop', machine: MACHINE, relayLocation: 'local', relayPort: 8792 })}\n`, { mode: 0o600 });
        const relayEntry = join(home, 'relay-fixture.mjs');
        listeningRelayFixture(relayEntry);
        const hostEntry = join(home, 'host-fixture.mjs');
        writeFileSync(hostEntry, [
            "setTimeout(() => process.stdout.write('link relay: online\\npairing: ready\\n'), 150);",
            'setInterval(() => {}, 1000);',
            '',
        ].join('\n'));

        const { runtime, statuses } = collectingRuntime(home, relayEntry, hostEntry);
        try {
            await runtime.start();
        } finally {
            runtime.stop();
            await new Promise((resolve) => setTimeout(resolve, 300));
        }

        expect(statuses.at(-1)?.phase).toBe('online');
    }, 30_000);

    it('offers Try again while a slow host starts, then follows it online', async () => {
        // A computer with no Herdr brings its host up late, here after a killed
        // host left its pair.sock behind. The window must follow the host's own
        // reports: link online, then its pairing socket listening.
        const home = mkdtempSync(join(tmpdir(), 'muxr-desktop-slow-'));
        writeFileSync(join(home, 'selfhost.json'), `${JSON.stringify({ version: 1, createdBy: 'desktop', machine: MACHINE, relayLocation: 'local', relayPort: 8792 })}\n`, { mode: 0o600 });
        mkdirSync(join(home, 'host'));
        writeFileSync(join(home, 'host', 'pair.sock'), '');
        const relayEntry = join(home, 'relay-fixture.mjs');
        listeningRelayFixture(relayEntry);
        const hostEntry = join(home, 'host-fixture.mjs');
        writeFileSync(hostEntry, [
            'setTimeout(() => process.stdout.write(\'link relay: online\\n\'), 100);',
            'setTimeout(() => process.stdout.write(\'pairing: ready\\n\'), 1500);',
            'setInterval(() => {}, 1000);',
            '',
        ].join('\n'));

        const { runtime, statuses } = collectingRuntime(home, relayEntry, hostEntry, process.execPath, 300);
        try {
            await runtime.start();
        } finally {
            await runtime.stop();
        }

        expect(statuses.map((status) => status.phase)).toEqual(['starting', 'stalled', 'online']);
    }, 30_000);

    it('on a computer with no Herdr, installs it from the window through the pinned sha256 fetch and starts it', async () => {
        // An older herdr (below the minimum) sits first on PATH; the install folder is empty.
        const home = mkdtempSync(join(tmpdir(), 'muxr-desktop-noherdr-'));
        writeFileSync(join(home, 'selfhost.json'), `${JSON.stringify({ version: 1, createdBy: 'desktop', machine: MACHINE, relayLocation: 'local', relayPort: 8792 })}\n`, { mode: 0o600 });
        const emptyPath = join(home, 'path');
        const installDir = join(home, 'bin');
        mkdirSync(emptyPath);
        writeFileSync(join(emptyPath, 'herdr'), "#!/bin/sh\necho 'herdr 0.8.0'\n", { mode: 0o755 });
        // The pinned release asset, served from a loopback fixture: a herdr whose server reports running once started.
        const asset = [
            '#!/bin/sh',
            `case "$1" in --version) echo 'herdr 0.9.1' ;; server) : > ${JSON.stringify(join(home, 'server-up'))} ;; status) [ -e ${JSON.stringify(join(home, 'server-up'))} ] && echo '{"running":true}' || echo '{"running":false}' ;; esac`,
            '',
        ].join('\n');
        const assetSha = createHash('sha256').update(asset).digest('hex');
        let served = 0;
        const fixture = createServer((_request, response) => { served += 1; response.end(asset); });
        await new Promise<void>((resolve) => fixture.listen(0, '127.0.0.1', resolve));
        const fixtureUrl = `http://127.0.0.1:${(fixture.address() as AddressInfo).port}/herdr`;
        const relayEntry = join(home, 'relay-fixture.mjs');
        listeningRelayFixture(relayEntry);
        const hostEntry = join(home, 'host-fixture.mjs');
        writeFileSync(hostEntry, [
            "process.stdout.write('link relay: online\\npairing: ready\\n');",
            'setInterval(() => {}, 1000);',
            '',
        ].join('\n'));

        const saved = { HOME: process.env.HOME, PATH: process.env.PATH, HERDR_BIN: process.env.HERDR_BIN, HERDR_INSTALL_DIR: process.env.HERDR_INSTALL_DIR, MUXR_HERDR_BINARY_URL: process.env.MUXR_HERDR_BINARY_URL, MUXR_HERDR_BINARY_SHA256: process.env.MUXR_HERDR_BINARY_SHA256, MUXR_HOME: process.env.MUXR_HOME, MUXR_NO_SERVICE_COMMANDS: process.env.MUXR_NO_SERVICE_COMMANDS };
        Object.assign(process.env, { HOME: home, PATH: emptyPath, HERDR_INSTALL_DIR: installDir, MUXR_HERDR_BINARY_URL: 'http://127.0.0.1:1/herdr', MUXR_HERDR_BINARY_SHA256: assetSha, MUXR_HOME: home, MUXR_NO_SERVICE_COMMANDS: '1' });
        delete process.env.HERDR_BIN;
        const shown: { status: string; step?: string; message?: string }[] = [];
        const herdr = createHerdrSetup((next: { status: string }) => shown.push(next));
        const { runtime, statuses } = collectingRuntime(home, relayEntry, hostEntry);
        try {
            // Pairing still comes up; the window says Herdr is missing beside it.
            await Promise.all([runtime.start(), herdr.check()]);
            expect(statuses.at(-1)?.phase).toBe('online');
            expect(shown).toEqual([{ status: 'missing' }]);

            // Offline: the fetch fails in plain words, and nothing is written.
            await herdr.install();
            expect(shown.at(-1)).toEqual({ status: 'failed', message: "Couldn't install Herdr. Check this computer's internet connection, then press Try again." });
            expect(existsSync(join(installDir, 'herdr'))).toBe(false);

            // Tampered or wrong-hash download: refused, and no file is left behind.
            process.env.MUXR_HERDR_BINARY_URL = fixtureUrl;
            process.env.MUXR_HERDR_BINARY_SHA256 = createHash('sha256').update('tampered').digest('hex');
            await herdr.install();
            expect(shown.at(-1)?.status).toBe('failed');
            expect(existsSync(join(installDir, 'herdr'))).toBe(false);

            // The pinned asset verifies and installs; the server then starts.
            process.env.MUXR_HERDR_BINARY_SHA256 = assetSha;
            await herdr.install();
            expect(shown.slice(-3).map((entry) => entry.step ?? entry.status)).toEqual(['Downloading Herdr…', 'Starting Herdr…', 'ok']);
            expect(served).toBeGreaterThan(0);
            expect(existsSync(join(home, 'server-up'))).toBe(true);
        } finally {
            await runtime.stop();
            await new Promise<void>((resolve) => fixture.close(() => resolve()));
            for (const [name, value] of Object.entries(saved)) {
                if (value === undefined) delete process.env[name];
                else process.env[name] = value;
            }
        }
    }, 30_000);

    it('starts an installed Herdr only once the desktop owns the computer', async () => {
        // The fake Herdr leaves a marker when its server starts, so a start is observable.
        const root = mkdtempSync(join(tmpdir(), 'muxr-desktop-herdr-owner-'));
        const installDir = join(root, 'bin');
        mkdirSync(installDir);
        const serverUp = join(root, 'server-up');
        // Herdr sits outside PATH and the install folder; only the CLI service's pin reaches it.
        const herdrPath = join(root, 'elsewhere', 'herdr');
        mkdirSync(join(root, 'elsewhere'));
        const fakeHerdr = (version: string) => writeFileSync(herdrPath, [
            '#!/bin/sh',
            `case "$1" in --version) echo 'herdr ${version}' ;; server) : > ${JSON.stringify(serverUp)} ;; status) [ -e ${JSON.stringify(serverUp)} ] && echo '{"running":true}' || echo '{"running":false}' ;; esac`,
            '',
        ].join('\n'), { mode: 0o755 });
        fakeHerdr('0.9.1');
        mkdirSync(join(root, '.config', 'systemd', 'user'), { recursive: true });
        writeFileSync(join(root, '.config', 'systemd', 'user', 'muxr.service'), `[Service]\nEnvironment=HERDR_BIN=${herdrPath}\n`);
        const cliHome = join(root, 'cli');
        const ownHome = join(root, 'own');
        mkdirSync(cliHome);
        mkdirSync(ownHome);
        writeFileSync(join(cliHome, 'selfhost.json'), `${JSON.stringify({ version: 1, machine: MACHINE, relayLocation: 'local', relayPort: 8792 })}\n`, { mode: 0o600 });
        writeFileSync(join(ownHome, 'selfhost.json'), `${JSON.stringify({ version: 1, createdBy: 'desktop', machine: MACHINE, relayLocation: 'local', relayPort: 8792 })}\n`, { mode: 0o600 });
        const relayEntry = join(root, 'relay-fixture.mjs');
        listeningRelayFixture(relayEntry);
        const hostEntry = join(root, 'host-fixture.mjs');
        writeFileSync(hostEntry, [
            "process.stdout.write('link relay: online\\npairing: ready\\n');",
            'setInterval(() => {}, 1000);',
            '',
        ].join('\n'));

        const saved = { HOME: process.env.HOME, PATH: process.env.PATH, HERDR_BIN: process.env.HERDR_BIN, HERDR_INSTALL_DIR: process.env.HERDR_INSTALL_DIR, MUXR_HOME: process.env.MUXR_HOME, MUXR_NO_SERVICE_COMMANDS: process.env.MUXR_NO_SERVICE_COMMANDS };
        const emptyPath = join(root, 'path');
        mkdirSync(emptyPath);
        Object.assign(process.env, { HOME: root, PATH: emptyPath, HERDR_INSTALL_DIR: installDir, MUXR_NO_SERVICE_COMMANDS: '1' });
        delete process.env.HERDR_BIN;
        const shown: { status: string }[] = [];
        const herdr = createHerdrSetup((next: { status: string }) => shown.push(next));
        try {
            // A command-line computer: the launch check reads the pinned Herdr, and no status starts it.
            process.env.MUXR_HOME = cliHome;
            const cli = collectingRuntime(cliHome, relayEntry, hostEntry).runtime;
            wireHerdrToRuntime(cli, herdr);
            await expect(cli.start()).rejects.toThrow(RelayOwnedError);
            await new Promise((resolve) => setTimeout(resolve, 600));
            expect(existsSync(serverUp)).toBe(false);
            expect(shown).toEqual([]);

            // A Herdr below the minimum counts as missing at launch, before any online report.
            fakeHerdr('0.8.0');
            process.env.MUXR_HOME = ownHome;
            const belowMinimum = collectingRuntime(ownHome, relayEntry, hostEntry).runtime;
            wireHerdrToRuntime(belowMinimum, herdr);
            expect(shown.at(-1)).toEqual({ status: 'missing' });
            // No online report yet, so nothing may have started: the launch
            // check read the pinned Herdr and the CLI phase left no trace.
            expect(existsSync(serverUp)).toBe(false);
            expect(shown).toEqual([{ status: 'missing' }]);

            // The runtime's own online report is what starts an installed Herdr.
            fakeHerdr('0.9.1');
            const { runtime, statuses } = collectingRuntime(ownHome, relayEntry, hostEntry);
            wireHerdrToRuntime(runtime, herdr);
            try {
                await runtime.start();
                expect(statuses.at(-1)?.phase).toBe('online');
                // The wiring forwards the online report without waiting for
                // the server start, so wait for the window to show it.
                const deadline = Date.now() + 10_000;
                while (shown.at(-1)?.status !== 'ok' && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
                expect(existsSync(serverUp)).toBe(true);
                expect(shown.at(-1)).toEqual({ status: 'ok' });
            } finally {
                await runtime.stop();
            }
        } finally {
            for (const [name, value] of Object.entries(saved)) {
                if (value === undefined) delete process.env[name];
                else process.env[name] = value;
            }
        }
    }, 30_000);

    it('keeps the stored advertised relay url across a relaunch', async () => {
        const home = mkdtempSync(join(tmpdir(), 'muxr-desktop-relaunch-'));
        const stored = `${JSON.stringify({ version: 1, createdBy: 'desktop', machine: MACHINE, relayLocation: 'local', relayPort: 8792, relayUrl: 'wss://relay.example.test', bindHost: '127.0.0.1' })}\n`;
        writeFileSync(join(home, 'selfhost.json'), stored, { mode: 0o600 });
        const dump = join(home, 'relay-env.json');
        const relayEntry = join(home, 'relay-fixture.mjs');
        writeFileSync(relayEntry, [
            "import { writeFileSync } from 'node:fs';",
            `writeFileSync(${JSON.stringify(dump)}, JSON.stringify({ relayUrl: process.env.MUXR_RELAY_MDNS_RELAY, bindHost: process.env.MUXR_RELAY_HOST }));`,
            "setTimeout(() => process.stdout.write('relay listening on ws://127.0.0.1:8792\\n'), 150);",
            'setInterval(() => {}, 1000);',
            '',
        ].join('\n'));
        const hostEntry = join(home, 'host-fixture.mjs');
        writeFileSync(hostEntry, [
            "setTimeout(() => process.stdout.write('link relay: online\\npairing: ready\\n'), 150);",
            'setInterval(() => {}, 1000);',
            '',
        ].join('\n'));

        const { runtime, statuses } = collectingRuntime(home, relayEntry, hostEntry);
        try {
            await runtime.start();
        } finally {
            runtime.stop();
            await new Promise((resolve) => setTimeout(resolve, 300));
        }

        expect(statuses.at(-1)?.phase).toBe('online');
        expect(JSON.parse(readFileSync(dump, 'utf8'))).toEqual({ relayUrl: 'wss://relay.example.test', bindHost: '127.0.0.1' });
        expect(readFileSync(join(home, 'selfhost.json'), 'utf8')).toBe(stored);
    }, 30_000);

    it('asks the user to quit the earlier desktop session when its relay is still alive', async () => {
        const home = mkdtempSync(join(tmpdir(), 'muxr-desktop-owned-'));
        writeFileSync(join(home, 'selfhost.json'), `${JSON.stringify({ version: 1, createdBy: 'desktop', machine: MACHINE, relayLocation: 'local', relayPort: 8792 })}\n`, { mode: 0o600 });
        const spawnLog = join(home, 'relay-spawns.log');
        const relayEntry = join(home, 'relay-owned-fixture.mjs');
        writeFileSync(relayEntry, [
            "import { appendFileSync } from 'node:fs';",
            `appendFileSync(${JSON.stringify(spawnLog)}, 'spawn' + String.fromCharCode(10));`,
            "throw new Error('another relay already owns ' + process.env.MUXR_RELAY_DATA_DIR + ' (pid 4242)');",
            '',
        ].join('\n'));

        const { runtime, statuses } = collectingRuntime(home, relayEntry, join(home, 'unused-host.mjs'));
        await expect(runtime.start()).rejects.toThrow(RelayOwnedError);

        expect(statuses.at(-1)?.phase).toBe('already-running');
        expect(statuses.at(-1)?.message).toContain('An earlier muxr desktop session is still running (process 4242)');
        expect(statuses.at(-1)?.canRetry).toBe(true);
        expect(readFileSync(spawnLog, 'utf8').trim().split('\n')).toHaveLength(1);
    });

    it('refuses a corrupt state instead of overwriting it', async () => {
        const home = mkdtempSync(join(tmpdir(), 'muxr-desktop-corrupt-'));
        const corrupt = '{ this is not json';
        writeFileSync(join(home, 'selfhost.json'), corrupt, { mode: 0o600 });

        const { runtime } = collectingRuntime(home, join(home, 'unused-relay.mjs'), join(home, 'unused-host.mjs'));
        await expect(runtime.start()).rejects.toThrow(/could not be read/);

        expect(readFileSync(join(home, 'selfhost.json'), 'utf8')).toBe(corrupt);
    });

    it('fails fast when the host cannot be spawned, without an unhandled error', async () => {
        const home = mkdtempSync(join(tmpdir(), 'muxr-desktop-nonode-'));
        writeFileSync(join(home, 'selfhost.json'), `${JSON.stringify({ version: 1, createdBy: 'desktop', machine: MACHINE, relayLocation: 'local', relayPort: 8792 })}\n`, { mode: 0o600 });
        // The relay runs from a tiny shell copied into the home; it unlinks that
        // shell before it announces itself, so the host spawn finds no executable.
        const node = join(home, 'sh');
        copyFileSync(realpathSync('/bin/sh'), node);
        chmodSync(node, 0o755);
        const relayEntry = join(home, 'relay-fixture.sh');
        writeFileSync(relayEntry, [
            '#!/bin/sh',
            `rm -f ${JSON.stringify(node)}`,
            "printf 'relay listening on ws://127.0.0.1:8792\\n'",
            'while true; do sleep 1; done',
            '',
        ].join('\n'));
        chmodSync(relayEntry, 0o755);

        const { runtime, statuses } = collectingRuntime(home, relayEntry, join(home, 'host-fixture.sh'), node);
        const started = Date.now();
        let thrown;
        try {
            await runtime.start();
        } catch (error) { thrown = error; }
        // The spawn error arrives on the child's next tick; let it land before stop().
        await new Promise((resolve) => setTimeout(resolve, 150));
        const elapsed = Date.now() - started;
        await runtime.stop();

        expect(thrown instanceof Error ? thrown.message : '').toMatch(/host could not be started/);
        expect(elapsed).toBeLessThan(5_000);
        expect(statuses.some((status) => status.phase === 'error' && (status.message ?? '').includes('host could not start'))).toBe(true);
    }, 15_000);
});
