#!/usr/bin/env node
/**
 * Isolated muxr+herdr sandbox for plugin-ecosystem testing.
 *
 * Boots a second herdr server whose HOME/XDG live under the sandbox dir, so
 * nothing touches the developer's real ~/.muxr, ~/.config/herdr, or ~/.herdr.
 * Agents (or humans) then run `muxr`/`herdr`/`npm` inside `env` to act like a
 * fresh user on a fresh machine.
 *
 *   node scripts/sandbox.mjs up [name]        create + start (default name: gauntlet)
 *   node scripts/sandbox.mjs env [name]       print a fully isolated fresh-user environment
 *   node scripts/sandbox.mjs agent-env [name] isolate muxr/herdr/npm but keep HOME for agent config
 *   node scripts/sandbox.mjs status [name]    sandbox server status
 *   node scripts/sandbox.mjs down [name]      stop server, keep files
 *   node scripts/sandbox.mjs destroy [name]   stop server, delete everything
 */
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, openSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const [command = 'up', name = 'gauntlet'] = process.argv.slice(2);
if (!/^[a-z0-9-]{1,32}$/.test(name)) throw new Error('sandbox name must be [a-z0-9-]{1,32}');
const root = join('/tmp', 'muxr-sandbox', name);
const home = join(root, 'home');
const socket = join(home, '.config', 'herdr', 'herdr.sock');

/** Env for anything running inside the sandbox: fresh HOME, isolated herdr/muxr, private npm global. */
function sandboxEnv() {
    const env = { ...process.env };
    for (const key of Object.keys(env)) if (key.startsWith('HERDR_') || key === 'MUXR_HOME') delete env[key];
    return {
        ...env,
        HOME: home,
        XDG_CONFIG_HOME: join(home, '.config'),
        XDG_DATA_HOME: join(home, '.local', 'share'),
        XDG_STATE_HOME: join(home, '.local', 'state'),
        MUXR_HOME: join(home, '.muxr'),
        npm_config_prefix: join(home, 'npm'),
        PATH: `${join(home, 'npm', 'bin')}:${process.env.PATH}`,
    };
}

function serverRunning() {
    try {
        const out = execFileSync('herdr', ['status'], { env: sandboxEnv(), encoding: 'utf8' });
        return /status:\s*running/.test(out);
    } catch {
        return false;
    }
}

if (command === 'up') {
    mkdirSync(join(home, '.config'), { recursive: true });
    mkdirSync(join(home, 'npm', 'bin'), { recursive: true });
    if (serverRunning()) {
        console.log(`sandbox '${name}' already running at ${socket}`);
    } else {
        const log = openSync(join(root, 'herdr-server.log'), 'a');
        const child = spawn('herdr', ['server'], { env: sandboxEnv(), detached: true, stdio: ['ignore', log, log] });
        child.unref();
        const deadline = Date.now() + 15_000;
        while (Date.now() < deadline && !serverRunning()) execFileSync('sleep', ['0.5']);
        if (!serverRunning()) throw new Error(`sandbox herdr server did not start; see ${join(root, 'herdr-server.log')}`);
        console.log(`sandbox '${name}' up: ${socket}`);
    }
    console.log(`source with:  eval "$(node ${process.argv[1]} env ${name})"`);
} else if (command === 'env' || command === 'agent-env') {
    for (const key of Object.keys(process.env)) {
        if (key.startsWith('HERDR_') || key === 'MUXR_HOME') console.log(`unset ${key}`);
    }
    const values = {
        HOME: home,
        XDG_CONFIG_HOME: join(home, '.config'),
        XDG_DATA_HOME: join(home, '.local', 'share'),
        XDG_STATE_HOME: join(home, '.local', 'state'),
        MUXR_HOME: join(home, '.muxr'),
        npm_config_prefix: join(home, 'npm'),
    };
    const keys = command === 'env'
        ? Object.keys(values)
        : ['XDG_CONFIG_HOME', 'MUXR_HOME', 'npm_config_prefix'];
    for (const key of keys) console.log(`export ${key}=${JSON.stringify(values[key])}`);
    console.log(`export PATH=${JSON.stringify(join(home, 'npm', 'bin'))}:"$PATH"`);
} else if (command === 'status') {
    execFileSync('herdr', ['status'], { env: sandboxEnv(), stdio: 'inherit' });
} else if (command === 'down' || command === 'destroy') {
    if (serverRunning()) execFileSync('herdr', ['server', 'stop'], { env: sandboxEnv(), stdio: 'inherit' });
    if (command === 'destroy' && existsSync(root)) {
        rmSync(root, { recursive: true, force: true });
        console.log(`sandbox '${name}' destroyed`);
    } else {
        console.log(`sandbox '${name}' stopped; files kept at ${root}`);
    }
} else {
    throw new Error(`unknown command '${command}'; use up|env|agent-env|status|down|destroy`);
}
