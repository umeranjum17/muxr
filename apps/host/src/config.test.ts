import { expect, it } from 'vitest';

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
}, 30_000);

/** One flow: `--fake` and source-build starts through the real built entrypoint — refused on the owner's real default home, started in a test home. */
it('built fake and source hosts refuse the default home and start in an explicit test home', async () => {
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
        // A refusal is an invocation error: non-zero, so lab scripts stop.
        const withoutHome = spawnHost(['--fake'], {});
        expect(withoutHome.status).toBe(1);
        expect(withoutHome.stderr).toContain('MUXR_HOME');
        expect(withoutHome.stderr).not.toContain('unexpected host startup');

        // Refused when MUXR_HOME names the owner's real default ~/.muxr.
        const atOwnerDefault = spawnHost(['--fake'], { MUXR_HOME: join(home, 'owner', '.muxr') });
        expect(atOwnerDefault.status).toBe(1);
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

        // A normal start from this source build is refused the same way
        // (17 Oct: a source lab host replaced the owner's host on the link).
        const sourceWithoutHome = spawnHost([], { MUXR_MODE: 'local' });
        expect(sourceWithoutHome.status).toBe(1);
        expect(sourceWithoutHome.stderr).toContain('a source build refuses the default muxr home');
        expect(sourceWithoutHome.stderr).not.toContain('unexpected host startup');
        const sourceAtOwnerDefault = spawnHost([], { MUXR_MODE: 'local', MUXR_HOME: join(home, 'owner', '.muxr') });
        expect(sourceAtOwnerDefault.status).toBe(1);
        expect(sourceAtOwnerDefault.stderr).toContain('MUXR_HOME');

        // With a test home it gets past the guard into host startup work
        // (the herdr client spawn trips the stub).
        const sourceInTestHome = spawnHost([], { MUXR_MODE: 'local', MUXR_HOME: testHome });
        expect(sourceInTestHome.status).toBe(97);
        expect(sourceInTestHome.stderr).toContain('unexpected host startup');

        // The shipped bundles (installed CLI, desktop app) define
        // MUXR_PACKAGED=1 at bundle time: their normal start without
        // MUXR_HOME is unchanged.
        const installed = spawnHost([], { MUXR_MODE: 'local', MUXR_PACKAGED: '1' });
        expect(installed.status).toBe(97);
        expect(installed.stderr).toContain('unexpected host startup');
    } finally {
        rmSync(home, { recursive: true, force: true });
    }
}, 30_000);
