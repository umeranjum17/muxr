/**
 * A self-host state written by a `muxr` CLI install is authoritative. Launching
 * the desktop app must run the host against that config and leave the file
 * byte-for-byte unchanged, so a remote relay setup is not silently rewritten to
 * a local one.
 */
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MuxrRuntime } from './runtime.mjs';

describe('desktop runtime self-host state', () => {
    it('keeps an existing remote-relay CLI config exactly as it is', async () => {
        const home = mkdtempSync(join(tmpdir(), 'muxr-desktop-state-'));
        const statePath = join(home, 'selfhost.json');
        const cliState = {
            version: 1,
            machine: {
                id: 'machine-cli-owner',
                name: 'cli-host',
                crypto: {
                    signingPublicKey: 'signing-public',
                    signingSecretKey: 'signing-secret',
                    boxPublicKey: 'box-public',
                    boxSecretKey: 'box-secret',
                    dataKey: 'data-key',
                    keyVersion: 1,
                    devices: [],
                },
            },
            relayLocation: 'remote',
            relayUrl: 'wss://relay.example.test',
            connectionMode: 'shared',
            relayRole: 'shared-relay-owner',
            relayPort: 8792,
            mintSecret: 'cli-owned-mint-secret',
            machineCredential: 'cli-credential',
        };
        const before = `${JSON.stringify(cliState)}\n`;
        writeFileSync(statePath, before, { mode: 0o600 });

        // Stands in for the relay the desktop app would keep alive itself; it
        // must never be launched for a state that already names a relay.
        const relayEntry = join(home, 'relay-fixture.mjs');
        writeFileSync(relayEntry, [
            "import { mkdirSync, writeFileSync } from 'node:fs';",
            "import { join } from 'node:path';",
            "mkdirSync(process.env.MUXR_RELAY_DATA_DIR, { recursive: true });",
            "writeFileSync(join(process.env.MUXR_RELAY_DATA_DIR, 'mint-secret'), JSON.stringify('desktop-mint-secret'));",
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

        const runtime = new MuxrRuntime({ home, node: process.execPath, relayEntry, hostEntry, port: 8792 });
        try {
            await runtime.start();
        } finally {
            runtime.stop();
            await new Promise((resolve) => setTimeout(resolve, 300));
        }

        expect(readFileSync(statePath, 'utf8')).toBe(before);
    }, 30_000);
});
