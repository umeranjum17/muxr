#!/usr/bin/env node
import { closeSync, existsSync, openSync, readFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { join } from 'node:path';

let context = {};
try { context = JSON.parse(process.env.HERDR_PLUGIN_CONTEXT_JSON ?? '{}'); } catch {}
const cwd = typeof context.focused_pane_cwd === 'string' ? context.focused_pane_cwd : undefined;
const stateDir = process.env.HERDR_PLUGIN_STATE_DIR;
const packagePath = cwd && join(cwd, 'package.json');
if (!cwd || !packagePath || !existsSync(packagePath)) {
    process.stderr.write('muxr Run Server: focused pane has no package.json\n');
    process.exitCode = 1;
} else {
    let scripts;
    try { scripts = JSON.parse(readFileSync(packagePath, 'utf8')).scripts; } catch {}
    if (typeof scripts?.dev !== 'string' || scripts.dev.trim() === '') {
        process.stderr.write('muxr Run Server: package.json has no dev script\n');
        process.exitCode = 1;
    } else {
        const choices = [['pnpm-lock.yaml', 'pnpm'], ['yarn.lock', 'yarn'], ['bun.lockb', 'bun'], ['bun.lock', 'bun']];
        const manager = choices.find(([lock]) => existsSync(join(cwd, lock)))?.[1] ?? 'npm';
        if (!stateDir) throw new Error('muxr Run Server: Herdr plugin state directory is unavailable');
        const logs = stateDir;
        await mkdir(logs, { recursive: true });
        const log = openSync(join(logs, 'dev-server.log'), 'a');
        const child = spawn(manager, ['run', 'dev'], { cwd, detached: true, stdio: ['ignore', log, log] });
        child.once('spawn', () => {
            closeSync(log);
            process.stdout.write(`Started ${manager} run dev in ${cwd}\n`);
        });
        child.once('error', (error) => {
            closeSync(log);
            process.stderr.write(`muxr Run Server: ${error.message}\n`);
            process.exitCode = 1;
        });
        child.unref();
    }
}
