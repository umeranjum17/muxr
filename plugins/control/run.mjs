#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = dirname(fileURLToPath(import.meta.url));
const packageCli = resolve(root, '../../cli.mjs');
const bundledCli = existsSync(packageCli) ? packageCli : resolve(root, '../../scripts/cli.mjs');
const command = process.argv[2];
const commands = new Map([
    ['setup', ['setup', '--from-plugin']],
    ['pair', ['pair']],
    ['devices', ['devices', 'list']],
    ['doctor', ['doctor']],
    ['service', ['daemon', 'status']],
    ['selfhost', ['self-host', '--web']],
]);
const argv = commands.get(command);

if (!argv) {
    process.stderr.write(`unknown muxr control action: ${command ?? ''}\n`);
    process.exitCode = 1;
} else {
    const executable = process.env.MUXR_BIN?.trim();
    const result = executable
        ? spawnSync(executable, argv, { stdio: 'inherit' })
        : spawnSync(process.execPath, [bundledCli, ...argv], { stdio: 'inherit' });
    if (result.error) process.stderr.write(`${result.error.message}\n`);
    process.exitCode = result.status ?? 1;
}
