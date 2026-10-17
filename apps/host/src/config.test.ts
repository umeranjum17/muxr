import { describe, expect, it } from 'vitest';
import {
    MuxrConfigError,
    muxrConfigPath,
    parseMuxrConfigFile,
    resolveHostConfig,
} from './config.js';

const PATH = '/tmp/muxr-test-home/config.json';
const DEFAULTS = {
    mode: 'local' as const,
    relayUrl: 'ws://127.0.0.1:8792',
    machineId: 'devbox',
    machineName: 'devbox',
    dataDir: '/tmp/muxr-test-home/host',
    hostHttpPort: 8793,
};

/** One flow: file on disk -> parse -> precedence -> host settings. */
describe('muxr config file', () => {
    it('lives beside the other MUXR_HOME state and falls back when absent', () => {
        expect(muxrConfigPath({ MUXR_HOME: '/tmp/muxr-test-home' })).toBe(PATH);
        expect(muxrConfigPath({})).toMatch(/\.muxr\/config\.json$/);
        expect(resolveHostConfig({ argv: [], env: {}, file: {}, defaults: DEFAULTS })).toEqual(DEFAULTS);
    });

    it('applies a partial hand-edited file over defaults', () => {
        const file = parseMuxrConfigFile(PATH, JSON.stringify({ machineName: 'desk', hostHttpPort: 9999 }));
        const resolved = resolveHostConfig({ argv: [], env: {}, file, defaults: DEFAULTS });
        expect(resolved.machineName).toBe('desk');
        expect(resolved.hostHttpPort).toBe(9999);
        expect(resolved.relayUrl).toBe(DEFAULTS.relayUrl);
    });

    it('prefers flag over environment over file over default per key', () => {
        const file = parseMuxrConfigFile(
            PATH,
            JSON.stringify({ relayUrl: 'ws://file:1', machineName: 'file', hostHttpPort: 1111 }),
        );
        const env = { MUXR_RELAY_URL: 'ws://env:2', MUXR_MACHINE_NAME: 'env', MUXR_HOST_HTTP_PORT: '2222' };
        const argv = ['--relay-url', 'ws://flag:3'];
        const resolved = resolveHostConfig({ argv, env, file, defaults: DEFAULTS });
        expect(resolved.relayUrl).toBe('ws://flag:3');
        expect(resolved.machineName).toBe('env');
        expect(resolved.hostHttpPort).toBe(2222);
        const fromFile = resolveHostConfig({ argv: [], env: {}, file, defaults: DEFAULTS });
        expect(fromFile.relayUrl).toBe('ws://file:1');
    });

    it('reports a broken file with path and key and never half-applies', () => {
        const cases: Array<[string, string, string]> = [
            ['{oops', '(file)', 'malformed JSON'],
            ['[1,2]', '(file)', 'must be a JSON object'],
            [JSON.stringify({ relayUrl: 'http://plain' }), 'relayUrl', 'ws:// or wss://'],
            [JSON.stringify({ mode: 'cloud' }), 'mode', 'selfhost'],
            [JSON.stringify({ hostHttpPort: 99999 }), 'hostHttpPort', '1 to 65535'],
            [JSON.stringify({ dataDir: 'relative/path' }), 'dataDir', 'absolute path'],
            [JSON.stringify({ mystery: 1 }), 'mystery', 'unknown setting'],
        ];
        for (const [text, key, reason] of cases) {
            let error: unknown;
            try {
                parseMuxrConfigFile(PATH, text);
            } catch (cause) {
                error = cause;
            }
            expect(error).toBeInstanceOf(MuxrConfigError);
            const message = (error as Error).message;
            expect(message).toContain(PATH);
            expect(message).toContain(key);
            expect(message).toContain(reason);
        }
    });
});

it('built host help exits before inherited settings can start the host', async () => {
    const { mkdtempSync, mkdirSync, writeFileSync, readdirSync, rmSync } = await import('node:fs');
    const { spawnSync } = await import('node:child_process');
    const { join, resolve } = await import('node:path');
    const { tmpdir } = await import('node:os');
    const home = mkdtempSync(join(tmpdir(), 'muxr-host-help-'));
    const muxrHome = join(home, 'muxr');
    mkdirSync(muxrHome);
    const config = join(muxrHome, 'config.json');
    writeFileSync(config, JSON.stringify({ mode: 'local', relayUrl: 'ws://127.0.0.1:1', machineName: 'Umer' }));
    // Safety tripwires at OS boundaries: execute the real built entrypoint,
    // but fail before a regression can reach Herdr, a listener, or a child.
    const guard = `
        import net from 'node:net';
        import cp from 'node:child_process';
        import { syncBuiltinESMExports } from 'node:module';
        const stop = () => { process.stderr.write('unexpected host startup\\n'); process.exit(97); };
        net.Socket.prototype.connect = stop;
        net.Server.prototype.listen = stop;
        for (const key of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) cp[key] = stop;
        syncBuiltinESMExports();
    `;
    const env = {
        PATH: process.env.PATH,
        HOME: home,
        XDG_CONFIG_HOME: join(home, 'config'),
        XDG_STATE_HOME: join(home, 'state'),
        MUXR_HOME: muxrHome,
        MUXR_MODE: 'local',
    };
    const run = (args: string[]) => spawnSync(process.execPath, [
        '--import', `data:text/javascript,${encodeURIComponent(guard)}`,
        resolve('apps/host/dist/main.js'), ...args,
    ], { env, encoding: 'utf8', timeout: 5000, maxBuffer: 100_000 });
    try {
        const help = run(['--help']);
        expect(help.error).toBeUndefined();
        expect(help.signal).toBeNull();
        expect(help.status).toBe(0);
        expect(help.stdout).toMatch(/Usage:.*host/);
        expect(help.stderr).toBe('');
        expect(readdirSync(muxrHome)).toEqual(['config.json']);

        const configuredStartup = run([]);
        expect(configuredStartup.status).toBe(97);
        expect(configuredStartup.stderr).toContain('unexpected host startup');

        // Broken settings and setup state must not mask help either.
        writeFileSync(config, '{broken fixture config');
        writeFileSync(join(muxrHome, 'selfhost.json'), '{broken fixture setup', { mode: 0o600 });
        const shortHelp = run(['-h']);
        expect(shortHelp.status).toBe(0);
        expect(shortHelp.stdout).toBe(help.stdout);
        expect(shortHelp.stderr).toBe('');

        rmSync(join(muxrHome, 'selfhost.json'));
        const startup = run([]);
        expect(startup.status).toBe(1);
        expect(startup.stderr).toContain('malformed JSON');
        expect(startup.stdout).not.toContain('Usage:');
    } finally {
        rmSync(home, { recursive: true, force: true });
    }
});

/** One flow: `--fake` through the real built entrypoint — refused on the owner's real default home, started in a test home. */
it('built fake host refuses the default home and starts in an explicit test home', async () => {
    const { mkdtempSync, mkdirSync, rmSync } = await import('node:fs');
    const { spawnSync } = await import('node:child_process');
    const { join, resolve } = await import('node:path');
    const { tmpdir } = await import('node:os');
    const home = mkdtempSync(join(tmpdir(), 'muxr-fake-home-'));
    // Safety tripwires at OS boundaries, as in the help flow above: a refused
    // start must reach nothing, and a started host may only touch the socket
    // layer before the guard trips it. The passwd home is pinned to a path
    // that does not exist, so even a broken guard can never touch a real one.
    const guard = `
        import net from 'node:net';
        import cp from 'node:child_process';
        import os from 'node:os';
        import { syncBuiltinESMExports } from 'node:module';
        const stop = () => { process.stderr.write('unexpected host startup\\n'); process.exit(97); };
        net.Socket.prototype.connect = stop;
        net.Server.prototype.listen = stop;
        for (const key of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) cp[key] = stop;
        os.userInfo = () => ({ username: 'owner', uid: 0, gid: 0, shell: null, homedir: ${JSON.stringify(join(home, 'owner'))} });
        syncBuiltinESMExports();
    `;
    const spawnHost = (args: string[], extraEnv: Record<string, string>) => spawnSync(process.execPath, [
        '--import', `data:text/javascript,${encodeURIComponent(guard)}`,
        resolve('apps/host/dist/main.js'), ...args,
    ], {
        env: { PATH: process.env.PATH, HOME: home, ...extraEnv },
        encoding: 'utf8', timeout: 5000, maxBuffer: 100_000,
    });
    try {
        // Refused without MUXR_HOME, even though this HOME is a throwaway folder.
        // A refusal is deterministic, so it exits clean (0), like auth faults.
        const withoutHome = spawnHost(['--fake'], {});
        expect(withoutHome.status).toBe(0);
        expect(withoutHome.stderr).toContain('MUXR_HOME');
        expect(withoutHome.stderr).not.toContain('unexpected host startup');

        // Refused when MUXR_HOME names the owner's real default ~/.muxr.
        const atOwnerDefault = spawnHost(['--fake'], { MUXR_HOME: join(home, 'owner', '.muxr') });
        expect(atOwnerDefault.status).toBe(0);
        expect(atOwnerDefault.stderr).toContain('MUXR_HOME');
        expect(atOwnerDefault.stderr).not.toContain('unexpected host startup');

        // A lab that already redirected HOME may still name its own .muxr
        // (the cross-side relay tests run exactly this shape).
        const redirectedLab = spawnHost(['--fake'], { MUXR_HOME: join(home, '.muxr') });
        expect(redirectedLab.status).toBe(0);
        expect(redirectedLab.stdout).toContain('(fake)');
        expect(redirectedLab.stderr).not.toContain('MUXR_HOME');

        // An explicit test home starts: the fake host prints its own ready line
        // (sockets are stubbed, so a started fake host then drains and exits 0).
        const testHome = join(home, 'lab');
        mkdirSync(testHome, { recursive: true });
        const started = spawnHost(['--fake'], { MUXR_HOME: testHome });
        expect(started.status).toBe(0);
        expect(started.stdout).toContain('host -> ws://127.0.0.1:8792 (fake) [local]');
        expect(started.stderr).not.toContain('MUXR_HOME');
        expect(started.stderr).not.toContain('unexpected host startup');

        // A normal (non-fake) start without MUXR_HOME is unchanged: it gets
        // past the fake-home guard into host startup work (the herdr client
        // spawn trips the stub) instead of being refused.
        const normal = spawnHost([], { MUXR_MODE: 'local' });
        expect(normal.status).toBe(97);
        expect(normal.stderr).toContain('unexpected host startup');
    } finally {
        rmSync(home, { recursive: true, force: true });
    }
});
