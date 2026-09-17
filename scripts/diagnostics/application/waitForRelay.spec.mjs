/**
 * The e2e checks are only worth their exit code if they talk to the relay they
 * started. This drives the real relay binary through both outcomes.
 *
 * Needs `tsc --build` to have produced apps/relay/dist. Every lane that runs
 * vitest builds first; a missing dist fails here rather than skipping quietly.
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { waitForRelay } from './waitForRelay.mjs';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const relayEntry = join(repo, 'apps', 'relay', 'dist', 'main.js');

const started = [];
const dataDirs = [];

function startRelayChild(port) {
    const dataDir = mkdtempSync(join(tmpdir(), 'muxr-waitforrelay-'));
    dataDirs.push(dataDir);
    const child = spawn(process.execPath, [relayEntry], {
        cwd: repo,
        env: {
            ...process.env,
            MUXR_RELAY_DEVELOPMENT_API: '1',
            MUXR_RELAY_HOST: '127.0.0.1',
            MUXR_RELAY_PORT: String(port),
            MUXR_RELAY_DATA_DIR: dataDir,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    started.push(child);
    return child;
}

afterEach(() => {
    for (const child of started.splice(0)) child.kill('SIGKILL');
    for (const dir of dataDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('waiting for a spawned relay', () => {
    it('refuses a stranger already on the port, and reports the port its own relay bound', async () => {
        // A relay from another worktree, another lane, or a previous run answers
        // /health exactly like ours would. Polling the port cannot tell them
        // apart, which is how a check went green having tested nothing it
        // started.
        const stranger = createServer((req, res) => {
            res.writeHead(req.url === '/health' ? 200 : 404, { 'content-type': 'application/json' });
            res.end('{"ok":true}');
        });
        await new Promise((done) => stranger.listen(0, '127.0.0.1', done));
        const taken = stranger.address().port;
        try {
            const health = await fetch(`http://127.0.0.1:${taken}/health`);
            expect(health.ok).toBe(true);

            const doomed = startRelayChild(taken);
            await expect(waitForRelay(doomed, 15_000)).rejects.toThrow(/exited before it was listening/);
            expect(doomed.exitCode === null ? doomed.signalCode : doomed.exitCode).not.toBe(0);
        } finally {
            await new Promise((done) => stranger.close(done));
        }

        // Port 0 and the relay's own announcement: no guessing, no collision.
        const port = await waitForRelay(startRelayChild(0), 15_000);
        expect(port).toBeGreaterThan(0);
        expect(port).not.toBe(taken);
        const answered = await fetch(`http://127.0.0.1:${port}/health`);
        expect(answered.ok).toBe(true);
    }, 45_000);
});
