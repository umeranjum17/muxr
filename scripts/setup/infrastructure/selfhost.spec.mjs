/**
 * The CLI must only stop a relay it recognizes as its own. The desktop app's
 * relay runs as relay.mjs, so the CLI refuses it and leaves the process alone.
 */
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { stopOwnedSelfhostRelay } from './selfhost.mjs';

const started = [];
const homes = [];
const originalHome = process.env.MUXR_HOME;

function startDesktopRelay(home) {
    const script = join(home, 'relay.mjs');
    writeFileSync(script, [
        "import { createServer } from 'node:http';",
        'const server = createServer((req, res) => {',
        "    res.writeHead(req.url === '/health' ? 200 : 404, { 'content-type': 'application/json' });",
        "    res.end('{\"ok\":true}');",
        '});',
        "server.listen(0, '127.0.0.1', () => process.stdout.write(String(server.address().port)));",
        '',
    ].join('\n'));
    const child = spawn(process.execPath, [script], { stdio: ['ignore', 'pipe', 'inherit'] });
    started.push(child);
    return new Promise((resolve, reject) => {
        let out = '';
        child.stdout.on('data', (chunk) => {
            out += chunk.toString();
            const port = Number(out);
            if (Number.isInteger(port) && port > 0) resolve(port);
        });
        child.once('error', reject);
        child.once('exit', (code) => reject(new Error(`desktop relay fixture exited (${code})`)));
    });
}

afterEach(() => {
    if (originalHome === undefined) delete process.env.MUXR_HOME;
    else process.env.MUXR_HOME = originalHome;
    for (const child of started.splice(0)) child.kill('SIGKILL');
    for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

describe('stopping a self-host relay', () => {
    it('refuses to stop a relay the desktop app owns', async () => {
        const home = mkdtempSync(join(tmpdir(), 'muxr-selfhost-spec-'));
        homes.push(home);
        process.env.MUXR_HOME = home;
        const port = await startDesktopRelay(home);
        const pid = started.at(-1).pid;
        writeFileSync(join(home, 'selfhost.json'), `${JSON.stringify({ version: 1, createdBy: 'desktop', relayLocation: 'local', relayPort: port })}\n`, { mode: 0o600 });
        mkdirSync(join(home, 'relay'), { recursive: true });
        writeFileSync(join(home, 'relay', 'relay.pid'), String(pid), { mode: 0o600 });

        await expect(stopOwnedSelfhostRelay()).rejects.toThrow(/does not belong to a muxr relay process/);

        expect(() => process.kill(pid, 0)).not.toThrow();
        const health = await fetch(`http://127.0.0.1:${port}/health`);
        expect(health.ok).toBe(true);
    }, 15_000);
});
