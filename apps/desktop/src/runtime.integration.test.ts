/**
 * The desktop app owns the relay and host only for the state it wrote itself.
 * State from the command-line install means muxr already runs there, so the app
 * refuses with one plain state; only a desktop-created state starts processes.
 */
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createHerdrSetup } from './herdrSetup.mjs';
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
            "import { mkdirSync, writeFileSync } from 'node:fs';",
            "import { join } from 'node:path';",
            "mkdirSync(join(process.env.MUXR_HOME, 'host'), { recursive: true });",
            "writeFileSync(join(process.env.MUXR_HOME, 'host', 'pair.sock'), '');",
            "setTimeout(() => process.stdout.write('link relay: online\\n'), 150);",
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
        // A computer with no Herdr brings its host up late. The window must
        // follow the host's own online report, and Ready waits for its pairing socket too.
        const home = mkdtempSync(join(tmpdir(), 'muxr-desktop-slow-'));
        writeFileSync(join(home, 'selfhost.json'), `${JSON.stringify({ version: 1, createdBy: 'desktop', machine: MACHINE, relayLocation: 'local', relayPort: 8792 })}\n`, { mode: 0o600 });
        const relayEntry = join(home, 'relay-fixture.mjs');
        listeningRelayFixture(relayEntry);
        const hostEntry = join(home, 'host-fixture.mjs');
        writeFileSync(hostEntry, [
            "import { mkdirSync, writeFileSync } from 'node:fs';",
            "import { join } from 'node:path';",
            'setTimeout(() => process.stdout.write(\'link relay: online\\n\'), 100);',
            'setTimeout(() => {',
            "    mkdirSync(join(process.env.MUXR_HOME, 'host'), { recursive: true });",
            "    writeFileSync(join(process.env.MUXR_HOME, 'host', 'pair.sock'), '');",
            '}, 1500);',
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

    it('on a computer with no Herdr, installs it from the window after an offline try and starts it', async () => {
        // No herdr anywhere the app looks: an empty PATH and an empty install folder.
        const home = mkdtempSync(join(tmpdir(), 'muxr-desktop-noherdr-'));
        writeFileSync(join(home, 'selfhost.json'), `${JSON.stringify({ version: 1, createdBy: 'desktop', machine: MACHINE, relayLocation: 'local', relayPort: 8792 })}\n`, { mode: 0o600 });
        const emptyPath = join(home, 'path');
        const installDir = join(home, 'bin');
        mkdirSync(emptyPath);
        const offline = join(home, 'offline');
        writeFileSync(offline, '');
        // The published installer's two outcomes: offline, or a herdr whose server reports running once started.
        const installer = join(home, 'install-herdr.sh');
        writeFileSync(installer, [
            '#!/bin/sh',
            `PATH=${JSON.stringify(process.env.PATH ?? '')}`,
            `if [ -e ${JSON.stringify(offline)} ]; then echo "error: can't reach https://herdr.dev/latest.json" >&2; exit 1; fi`,
            `mkdir -p ${JSON.stringify(installDir)}`,
            `cat > ${JSON.stringify(join(installDir, 'herdr'))} <<'HERDR'`,
            '#!/bin/sh',
            `case "$1" in server) : > ${JSON.stringify(join(home, 'server-up'))} ;; status) [ -e ${JSON.stringify(join(home, 'server-up'))} ] && echo '{"running":true}' || echo '{"running":false}' ;; esac`,
            'HERDR',
            `chmod +x ${JSON.stringify(join(installDir, 'herdr'))}`,
            '',
        ].join('\n'), { mode: 0o755 });
        const relayEntry = join(home, 'relay-fixture.mjs');
        listeningRelayFixture(relayEntry);
        const hostEntry = join(home, 'host-fixture.mjs');
        writeFileSync(hostEntry, [
            "import { mkdirSync, writeFileSync } from 'node:fs';",
            "import { join } from 'node:path';",
            "mkdirSync(join(process.env.MUXR_HOME, 'host'), { recursive: true });",
            "writeFileSync(join(process.env.MUXR_HOME, 'host', 'pair.sock'), '');",
            "writeFileSync(join(process.env.MUXR_HOME, 'host-path'), process.env.PATH);",
            "process.stdout.write('link relay: online\\n');",
            'setInterval(() => {}, 1000);',
            '',
        ].join('\n'));

        const saved = { PATH: process.env.PATH, HERDR_BIN: process.env.HERDR_BIN, HERDR_INSTALL_DIR: process.env.HERDR_INSTALL_DIR, MUXR_HERDR_INSTALLER: process.env.MUXR_HERDR_INSTALLER, MUXR_HOME: process.env.MUXR_HOME, MUXR_NO_SERVICE_COMMANDS: process.env.MUXR_NO_SERVICE_COMMANDS };
        Object.assign(process.env, { PATH: emptyPath, HERDR_INSTALL_DIR: installDir, MUXR_HERDR_INSTALLER: installer, MUXR_HOME: home, MUXR_NO_SERVICE_COMMANDS: '1' });
        delete process.env.HERDR_BIN;
        const shown: { status: string; step?: string; message?: string }[] = [];
        const herdr = createHerdrSetup((next: { status: string }) => shown.push(next));
        const { runtime, statuses } = collectingRuntime(home, relayEntry, hostEntry);
        try {
            // Pairing still comes up; the window says Herdr is missing beside it.
            await Promise.all([runtime.start(), herdr.check()]);
            expect(statuses.at(-1)?.phase).toBe('online');
            expect(shown).toEqual([{ status: 'missing' }]);
            // A Herdr installed later lands on the running host's PATH, so no restart is needed.
            expect(readFileSync(join(home, 'host-path'), 'utf8').split(':')).toContain(installDir);

            await herdr.install();
            expect(shown.at(-1)).toEqual({ status: 'failed', message: expect.stringContaining("couldn't reach herdr.dev") });

            rmSync(offline);
            await herdr.install();
            expect(shown.slice(-3).map((entry) => entry.step ?? entry.status)).toEqual(['Downloading Herdr…', 'Starting Herdr…', 'ok']);
            expect(existsSync(join(home, 'server-up'))).toBe(true);
        } finally {
            await runtime.stop();
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
            "import { mkdirSync, writeFileSync } from 'node:fs';",
            "import { join } from 'node:path';",
            "mkdirSync(join(process.env.MUXR_HOME, 'host'), { recursive: true });",
            "writeFileSync(join(process.env.MUXR_HOME, 'host', 'pair.sock'), '');",
            "setTimeout(() => process.stdout.write('link relay: online\\n'), 150);",
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
