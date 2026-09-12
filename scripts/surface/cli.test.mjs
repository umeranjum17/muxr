/**
 * Slice 2A CLI flows (not a matrix).
 *
 * The CLI prints accepted/visible/failed without internal ids in both human
 * and JSON modes, accepts `--` separators and the blank home target, and
 * reaches a live broker from a real standalone process without creating
 * panes, PTYs, Kitty graphics, CDP sessions or code-server processes.
 */
import { describe, expect, it } from 'vitest';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { redactForDisplay } from './brokerClient.mjs';
import { runSurfaceCli } from './index.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');

async function capture(argv, env = {}) {
    const out = [];
    const err = [];
    const realOut = process.stdout.write;
    const realErr = process.stderr.write;
    process.stdout.write = (chunk) => { out.push(String(chunk)); return true; };
    process.stderr.write = (chunk) => { err.push(String(chunk)); return true; };
    const realPane = process.env.HERDR_PANE_ID;
    const realDataDir = process.env.MUXR_DATA_DIR;
    process.env.HERDR_PANE_ID = 'w1:p1';
    process.env.MUXR_DATA_DIR = join(ROOT, '.tmp-surface-cli-test');
    Object.assign(process.env, env);
    try {
        const code = await runSurfaceCli(argv);
        return { code, stdout: out.join(''), stderr: err.join('') };
    } finally {
        process.stdout.write = realOut;
        process.stderr.write = realErr;
        if (realPane === undefined) delete process.env.HERDR_PANE_ID;
        else process.env.HERDR_PANE_ID = realPane;
        if (realDataDir === undefined) delete process.env.MUXR_DATA_DIR;
        else process.env.MUXR_DATA_DIR = realDataDir;
    }
}

describe('slice 2A CLI', () => {
    it('rejects bad input without leaking ids or secrets', async () => {
        const usage = await capture(['browser', 'open']);
        expect(usage.code).toBe(2);
        expect(usage.stderr).toMatch(/usage/);
        const unreachable = await capture(['surface', 'list']);
        expect(unreachable.code).toBe(1);
        expect(unreachable.stderr).toMatch(/surface:/);
        const combined = `${usage.stdout}${usage.stderr}${unreachable.stdout}${unreachable.stderr}`;
        expect(combined).not.toMatch(/sfo_|pvl_|pane-|pp_|token|secret|admission/i);
    });

    it('accepts separators and the blank home target instead of misreading them', async () => {
        // Before `--` handling, these parsed `--` as the target and failed
        // with usage. Now they reach the (unreachable here) host instead.
        for (const argv of [
            ['browser', 'open', '--beside', '--', 'about:blank'],
            ['browser', 'home', '--beside'],
            ['code', 'open', '--', '.'],
        ]) {
            const result = await capture(argv);
            expect(result.code).toBe(1);
            expect(result.stderr).toMatch(/surface:/);
            expect(result.stderr).not.toMatch(/usage/);
        }
    });

    it('strips handle-like fields before anything prints', () => {
        const cleaned = redactForDisplay({
            ok: true,
            outcome: 'accepted',
            surface: { name: 'browser', title: 'App', handle: 'sfo_abc123', lease: 'pvl_xyz', paneId: 'w1:p1', deviceId: 'd1', admission: 'a'.repeat(64) },
        });
        expect(JSON.stringify(cleaned)).not.toMatch(/sfo_|pvl_|w1:p1|admission|aaaa/);
        expect(cleaned).toMatchObject({ outcome: 'accepted', surface: { name: 'browser' } });
    });

    it('runs the first-class Browser and Code Tools entries through the broker path, never a pane', () => {
        // Each bundled plugin declares a Surface launch (`[surface]
        // launch = "broker"`), which muxr Tools runs in place with the
        // originating agent context, and its action script forwards to the
        // semantic muxr command: no pane, PTY, Kitty graphics, CDP session
        // or code-server process anywhere in the script.
        const dir = mkdtempSync(join(tmpdir(), 'muxr-tools-'));
        const log = join(dir, 'muxr.log');
        const stub = join(dir, 'muxr');
        writeFileSync(stub, `#!/bin/sh\necho "$@" >> ${JSON.stringify(log)}\n`);
        chmodSync(stub, 0o755);
        for (const plugin of ['browser', 'code']) {
            const manifest = readFileSync(join(ROOT, 'plugins', plugin, 'herdr-plugin.toml'), 'utf8');
            expect(manifest).toMatch(/\[surface\]\s*\nlaunch = "broker"/);
            expect(manifest).toMatch(/command = \["bash", "open\.sh"\]/);
            const script = readFileSync(join(ROOT, 'plugins', plugin, 'open.sh'), 'utf8');
            const commands = script.split('\n').filter((line) => !/^\s*#/.test(line)).join('\n');
            expect(commands).not.toMatch(/herdr |pane|pty|kitty|cdp|code-server|split/i);
            execFileSync('bash', [join(ROOT, 'plugins', plugin, 'open.sh')], { env: { ...process.env, MUXR_BIN: stub } });
        }
        const lines = readFileSync(log, 'utf8').trim().split('\n');
        expect(lines).toEqual(['browser open --beside -- about:blank', 'code open --beside -- .']);
    });

    it('reaches a live broker from a real standalone CLI process', async () => {
        // Regression: the standalone CLI exited 13 with "Detected unsettled
        // top-level await" because the broker client's bounded timer was
        // unref'd and nothing else kept the loop alive. In-process
        // runSurfaceCli cannot see that; only a real child process can.
        const { SurfaceBroker } = await import('../../apps/host/src/requests/infrastructure/surfaceBroker.js');
        const dataRoot = mkdtempSync(join(tmpdir(), 'muxr-surface-live-'));
        const workdir = mkdtempSync(join(tmpdir(), 'muxr-surface-work-'));
        const source = {
            async herdrTree() {
                return {
                    workspaces: [{
                        workspaceId: 'w1',
                        tabs: [{ tabId: 'w1:t1', panes: [{ paneId: 'w1:p1', sessionId: 'route-1', cwd: workdir }] }],
                        worktree: { path: workdir },
                    }],
                };
            },
            async pluginList() {
                return [{
                    pluginId: 'muxr.browser',
                    manifestHash: 'h1',
                    capabilities: { 'surface.browser.open': 'browser.describe' },
                }, {
                    pluginId: 'muxr.code',
                    manifestHash: 'h1',
                    capabilities: { 'surface.code.open': 'files.read' },
                }];
            },
        };
        const broker = new SurfaceBroker({ dataDir: join(dataRoot, 'host'), source });
        await broker.start();
        const execFileAsync = promisify(execFile);
        // Async spawn, never execFileSync: the broker under test lives on
        // this process's own event loop, and a synchronous wait would block
        // it from ever answering the child.
        const run = async (args, { paneId = undefined } = {}) => {
            // Production convention: MUXR_DATA_DIR is the host data dir
            // itself, so the client socket lands on the broker socket.
            const env = { ...process.env, MUXR_DATA_DIR: join(dataRoot, 'host') };
            if (paneId === undefined) delete env.HERDR_PANE_ID;
            else env.HERDR_PANE_ID = paneId;
            try {
                const { stdout } = await execFileAsync(process.execPath, [join(ROOT, 'scripts/cli.mjs'), ...args], {
                    cwd: workdir,
                    env,
                    stdio: ['ignore', 'pipe', 'pipe'],
                    timeout: 60_000,
                    encoding: 'utf8',
                });
                return { code: 0, stdout };
            } catch (error) {
                return {
                    code: typeof error.code === 'number' ? error.code : 1,
                    stdout: String(error.stdout ?? ''),
                    stderr: String(error.stderr ?? ''),
                };
            }
        };
        try {
            const caps = await run(['surface', 'capabilities', '--json']);
            expect({ code: caps.code, stderr: caps.stderr ?? '' }).toMatchObject({ code: 0 });
            const parsed = JSON.parse(caps.stdout);
            expect(parsed.ok).toBe(true);
            expect(parsed.capabilities).toContainEqual({
                capability: 'surface.browser.open',
                available: true,
                ambiguous: false,
            });
            expect(caps.stdout).not.toMatch(/sfo_|pvl_|pane-|pp_|token|secret|admission/i);

            const opened = await run(['browser', 'open', '--', 'about:blank'], { paneId: 'w1:p1' });
            expect({ code: opened.code, stderr: opened.stderr ?? '' }).toMatchObject({ code: 0 });
            expect(opened.stdout).toMatch(/Accepted .*browser.*about:blank/);
            expect(opened.stdout).not.toMatch(/sfo_|pvl_|pane-|pp_|token|secret|admission/i);

            // `code diff` is an opening command: fresh sessions with no open
            // offer get a root delta offer (create-or-replace), not a
            // "open one first" refusal. Only `browser update` refreshes.
            const diffed = await run(['code', 'diff'], { paneId: 'w1:p1' });
            expect({ code: diffed.code, stderr: diffed.stderr ?? '' }).toMatchObject({ code: 0 });
            expect(diffed.stdout).toMatch(/Accepted .*code.*\(diff, review\)/);
            expect(diffed.stdout).not.toMatch(/sfo_|pvl_|pane-|pp_|token|secret|admission/i);

            const named = await run(['code', 'diff', '--name', 'code-root'], { paneId: 'w1:p1' });
            expect({ code: named.code, stderr: named.stderr ?? '' }).toMatchObject({ code: 0 });
            expect(named.stdout).toMatch(/Accepted .*code-root.*\(diff, review\)/);
            expect(named.stdout).not.toMatch(/sfo_|pvl_|pane-|pp_|token|secret|admission/i);
        } finally {
            await broker.close();
        }
    });
});
