import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';

it('keeps install, repair and foreground startup in their service scope', () => {
    const root = mkdtempSync(join(tmpdir(), 'muxr-service-flow-'));
    const home = join(root, 'home');
    const bin = join(root, 'bin');
    const log = join(root, 'manager.log');
    mkdirSync(home); mkdirSync(bin);
    writeFileSync(log, '');
    for (const command of ['systemctl', 'launchctl', 'loginctl', 'systemd-run']) {
        writeFileSync(join(bin, command), `#!/bin/sh\nprintf '%s\\n' '${command}' "$*" >> '${log}'\nexit 0\n`, { mode: 0o755 });
    }
    const env = { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}`, MUXR_HOME: '', MUXR_MODE: '',
        MUXR_PLATFORM: 'linux', MUXR_NO_SERVICE_COMMANDS: '', MUXR_TEST_FAKE_SERVICE_MANAGERS: '1' };
    for (const key of ['MUXR_RELAY_TOKEN', 'MUXR_RELAY_URL', 'MUXR_MACHINE_ID', 'MUXR_RELAY_AUTH', 'MUXR_DATA_DIR']) delete env[key];
    const run = (args, extra = {}) => spawnSync(process.execPath, args, { env: { ...env, ...extra }, encoding: 'utf8', input: 'y\n', timeout: 15_000 });
    const cli = (args, extra) => run(['scripts/cli.mjs', ...args], extra);
    const script = (source, extra) => run(['--input-type=module', '-e', source], extra);
    const output = (result) => `${result.stdout}${result.stderr}`;
    try {
        // Same public commands as doctor repairs, with only the service manager replaced.
        expect(output(cli(['daemon', 'install', '--mode', 'relay']))).toContain('installed');
        expect(cli(['daemon', 'start']).status).toBe(0);
        expect(readFileSync(log, 'utf8')).toContain('enable --now muxr.service');
        const unit = join(home, '.config/systemd/user/muxr.service');
        const before = readFileSync(unit, 'utf8');
        writeFileSync(log, '');
        const scoped = { MUXR_HOME: join(root, 'other-home') };
        for (const action of ['install', 'start', 'restart', 'stop', 'uninstall']) {
            const result = cli(['daemon', action], scoped);
            expect(result.status, output(result)).toBe(1);
            expect(output(result)).toContain(resolve(scoped.MUXR_HOME));
        }
        // Raw manager calls and exported launchd bootstrap cannot bypass the guard.
        for (const source of [
            "import { serviceManagerRun } from './scripts/setup/infrastructure/runtime.mjs'; console.log(JSON.stringify(serviceManagerRun('systemctl', ['--user', 'restart', 'muxr.service'])));",
            "import { bootstrapMacService } from './scripts/setup/infrastructure/daemon.mjs'; console.log(JSON.stringify(bootstrapMacService('gui/123', '/fixture.plist')));",
        ]) {
            const result = script(source, scoped);
            expect(output(result)).toContain(resolve(scoped.MUXR_HOME));
            expect(JSON.parse(result.stdout).refused).toBe(true);
        }
        for (const action of ['plan', 'apply', 'status']) {
            const result = cli(['host-repair', JSON.stringify({ action, owner: 'Umer', appVersion: '9.9.8', protocol: 1 })], scoped);
            expect(result.status, output(result)).toBe(1);
            expect(output(result)).toContain(resolve(scoped.MUXR_HOME));
        }
        const worker = run(['scripts/release/application/repairHost.mjs', '--worker', join(root, 'absent-job')], scoped);
        expect(worker.status).toBe(1);
        expect(output(worker)).toContain(resolve(scoped.MUXR_HOME));
        expect(readFileSync(unit, 'utf8')).toBe(before);
        expect(readFileSync(log, 'utf8')).toBe('');
        expect(existsSync(join(scoped.MUXR_HOME, 'updates'))).toBe(false);

        // Accept doctor's offered re-registration repair under a scoped home.
        writeFileSync(unit, '[Service]\nExecStart=/missing/muxr\n');
        const doctor = script(`process.argv[1] = ${JSON.stringify(resolve('scripts/cli.mjs'))};
            process.stdin.isTTY = true; process.stdout.isTTY = true;
            const { inspectSetup } = await import('./scripts/setup/application/inspectSetup.mjs');
            await inspectSetup();`, { ...scoped, HERDR_BIN: join(root, 'missing-herdr') });
        expect(doctor.error).toBeUndefined();
        expect(output(doctor)).toContain('refusing service install');
        expect(output(doctor)).toContain(resolve(scoped.MUXR_HOME));
        expect(readFileSync(unit, 'utf8')).toBe('[Service]\nExecStart=/missing/muxr\n');
        writeFileSync(unit, before);

        // Public up reaches the foreground host, but cannot repair Herdr's unit first.
        const herdrUnit = join(home, '.config/systemd/user/herdr-server.service');
        const staleHerdr = '[Service]\nExecStart=/missing/herdr server\n';
        writeFileSync(herdrUnit, staleHerdr);
        const herdr = join(bin, 'herdr');
        writeFileSync(herdr, '#!/bin/sh\nexit 99\n', { mode: 0o755 });
        const up = cli(['up', '--fake', '--check-host-stopped'], { ...scoped, HERDR_BIN: herdr, MUXR_DATA_DIR: join(root, 'data') });
        expect(up.error).toBeUndefined();
        expect(up.status, output(up)).toBe(0);
        expect(output(up)).toContain('refusing service repair');
        expect(output(up)).toContain(resolve(scoped.MUXR_HOME));
        expect(output(up)).toContain('host stopped in');
        expect(readFileSync(herdrUnit, 'utf8')).toBe(staleHerdr);
        expect(readFileSync(log, 'utf8')).toBe('');

        // HOME alone also scopes service definitions, before any file is installed.
        const homeOnly = cli(['daemon', 'install'], { MUXR_TEST_FAKE_SERVICE_MANAGERS: '' });
        expect(homeOnly.status, output(homeOnly)).toBe(1);
        expect(output(homeOnly)).toContain(home);
        expect(readFileSync(unit, 'utf8')).toBe(before);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
}, 30_000);
