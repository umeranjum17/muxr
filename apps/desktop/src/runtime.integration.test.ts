/**
 * The desktop app owns the relay and host only for the state it wrote itself.
 * State from the command-line install means muxr already runs there, so the app
 * refuses with one plain state; only a desktop-created state starts processes.
 */
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
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

function collectingRuntime(home: string, relayEntry: string, hostEntry: string) {
    const statuses: { phase: string; message?: string }[] = [];
    const runtime = new MuxrRuntime({ home, node: process.execPath, relayEntry, hostEntry, port: 8792 });
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
        expect(readFileSync(join(home, 'selfhost.json'), 'utf8')).toBe(before);
        expect(existsSync(spawnLog)).toBe(false);
    });

    it('runs the relay and host for state the desktop created itself', async () => {
        const home = mkdtempSync(join(tmpdir(), 'muxr-desktop-own-'));
        writeFileSync(join(home, 'selfhost.json'), `${JSON.stringify({ version: 1, createdBy: 'desktop', machine: MACHINE, relayLocation: 'local', relayPort: 8792 })}\n`, { mode: 0o600 });
        const relayEntry = join(home, 'relay-fixture.mjs');
        writeFileSync(relayEntry, [
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
    }, 30_000);

    it('refuses and spawns once when the relay data dir already has an owner', async () => {
        const home = mkdtempSync(join(tmpdir(), 'muxr-desktop-owned-'));
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
        expect(readFileSync(spawnLog, 'utf8').trim().split('\n')).toHaveLength(1);
    });
});
