#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readFileSync, readSync, rmSync, symlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { delimiter, dirname, join, resolve } from 'node:path';

const root = dirname(fileURLToPath(import.meta.url));
const home = process.env.HOME?.trim() || homedir();

// A `herdr plugin install` build puts the CLI in the plugin root; a pack that
// ships inside the npm package or a checkout runs the CLI it came with.
const cli = [
    join(root, 'node_modules', '@trymuxr', 'cli', 'cli.mjs'),
    resolve(root, '../../cli.mjs'),
    resolve(root, '../../scripts/cli.mjs'),
].find((candidate) => existsSync(candidate));

const commands = new Map([
    ['setup', ['setup', '--from-plugin']],
    ['pair', ['pair']],
    ['devices', ['devices', 'list']],
    ['doctor', ['doctor']],
    ['service', ['daemon', 'status']],
    ['selfhost', ['self-host', '--web']],
    ['start', ['daemon', 'start']],
    ['stop', ['daemon', 'stop']],
    ['restart', ['daemon', 'restart']],
    ['status', ['status']],
    ['integration-sync', ['integrations', 'sync']],
    ['update', ['update', '--yes']],
    ['uninstall', ['uninstall']],
    ['desktop-setup', ['desktop', 'setup']],
    ['logs', ['daemon', 'logs']],
]);

/**
 * Herdr runs plugin commands with its server's environment, never the
 * user's shell, so an exported MUXR_HOME is invisible here. The home the
 * installed service runs with is the one these commands must act on.
 */
function muxrHome() {
    const explicit = process.env.MUXR_HOME?.trim();
    if (explicit) return explicit;
    const definitions = [
        join(home, '.config', 'systemd', 'user', 'muxr.service'),
        join(home, 'Library', 'LaunchAgents', 'com.muxr.host.plist'),
    ];
    for (const path of definitions) {
        let text;
        try { text = readFileSync(path, 'utf8'); } catch { continue; }
        const unit = /^Environment=MUXR_HOME="((?:[^"\\]|\\.)+)"$/m.exec(text)?.[1];
        if (unit) return unit.replace(/\\(.)/g, '$1').replaceAll('%%', '%');
        const plist = /<key>MUXR_HOME<\/key><string>([^<]+)<\/string>/.exec(text)?.[1];
        if (plist) return plist.replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&quot;', '"').replaceAll('&amp;', '&');
    }
    return join(home, '.muxr');
}

/**
 * A GitHub install puts nothing on PATH. This links `muxr` into
 * ~/.local/bin so shells and agents (`muxr name`, `muxr share`) find it.
 * It only ever replaces its own kind of entry: a symlink.
 */
function linkCli() {
    const bin = join(home, '.local', 'bin');
    const link = join(bin, 'muxr');
    let existing;
    try { existing = lstatSync(link); } catch { /* absent */ }
    if (existing !== undefined && !existing.isSymbolicLink()) {
        process.stderr.write(`${link} exists and is not a symlink; leaving it alone.\n`);
        return 1;
    }
    mkdirSync(bin, { recursive: true });
    if (existing !== undefined) rmSync(link);
    symlinkSync(cli, link);
    process.stdout.write(`Linked ${link} -> ${cli}\n`);
    if (!(process.env.PATH ?? '').split(delimiter).includes(bin)) {
        process.stdout.write(`${bin} is not on this PATH; add it to your shell profile to run \`muxr\`.\n`);
    }
    return 0;
}

const command = process.argv[2];
const argv = commands.get(command);
/**
 * One-shot panes vanish the moment their command exits, hiding the output.
 * In a pane (a real terminal on both sides; actions have none) hold the pane
 * open until the person presses Enter, then exit with the CLI's own status.
 */
function holdPaneOpen() {
    if (!process.stdin.isTTY || !process.stdout.isTTY) return;
    process.stdout.write('Press Enter to close.\n');
    const key = Buffer.alloc(1);
    try {
        while (readSync(0, key, 0, 1) > 0 && key[0] !== 0x0a) {}
    } catch { /* stdin went away; close anyway */ }
}

if (cli === undefined) {
    process.stderr.write('muxr CLI not found next to this plugin; reinstall it with `herdr plugin install`\n');
    process.exitCode = 1;
} else if (command === 'link-cli') {
    process.exitCode = linkCli();
} else if (!argv) {
    process.stderr.write(`unknown muxr control action: ${command ?? ''}\n`);
    process.exitCode = 1;
} else {
    const env = {
        ...process.env,
        MUXR_HOME: muxrHome(),
        // Herdr names its own binary for plugin commands; the CLI reads HERDR_BIN.
        ...(process.env.HERDR_BIN?.trim() || !process.env.HERDR_BIN_PATH?.trim() ? {} : { HERDR_BIN: process.env.HERDR_BIN_PATH }),
    };
    const executable = process.env.MUXR_BIN?.trim();
    const result = executable
        ? spawnSync(executable, argv, { stdio: 'inherit', env })
        : spawnSync(process.execPath, [cli, ...argv], { stdio: 'inherit', env });
    if (result.error) process.stderr.write(`${result.error.message}\n`);
    holdPaneOpen();
    process.exitCode = result.status ?? 1;
}
