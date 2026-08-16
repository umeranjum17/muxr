#!/usr/bin/env node
import { createRequire } from 'node:module';
import { runAccount, runDaemon, runDevices, runDoctor, runIntegrations, runSelfHost } from './local-setup.mjs';
import { runSetup } from './setup-wizard.mjs';
import { runPlugin } from './plugin.mjs';
import { runPackage } from './package.mjs';

const [command = 'up', ...args] = process.argv.slice(2);
let code = 0;

if (command === 'up') {
    await import('./host-up.mjs');
} else if (command === 'setup') {
    code = await runSetup(args);
} else if (command === 'self-host') {
    code = await runSelfHost(args);
} else if (command === 'devices') {
    const [deviceCommand = 'list', ...deviceArgs] = args;
    code = await runDevices(deviceCommand, deviceArgs);
} else if (command === 'doctor') {
    code = await runDoctor();
} else if (command === 'daemon') {
    code = await runDaemon(args);
} else if (command === 'integrations') {
    code = await runIntegrations(args);
} else if (command === 'plugin') {
    // One noun for users: `muxr plugin` authors and manages the same artifact
    // `herdr plugin` runs. create/check/dev author it; the rest manage it.
    const [pluginCommand = 'list', ...pluginArgs] = args;
    try {
        code = ['create', 'check', 'call', 'dev'].includes(pluginCommand)
            ? runPlugin(pluginCommand, pluginArgs)
            : await runPackage(pluginCommand, pluginArgs);
    } catch (error) {
        process.stderr.write(`muxr plugin: ${error instanceof Error ? error.message : String(error)}\n`);
        code = 1;
    }
} else if (command === 'pair') {
    code = await runAccount(command, args);
} else if (command === 'version' || command === '--version' || command === '-v') {
    const require = createRequire(import.meta.url);
    let pkg;
    try { pkg = require('./package.json'); } catch { pkg = require('../package.json'); }
    process.stdout.write(`${pkg.version}\n`);
} else {
    process.stdout.write(`muxr — connect this machine to muxr

  muxr setup [--mode selfhost] [--inspect]                     guided first-run setup
  muxr self-host [--advertise <url>] [--tunnel] [--port <n>]   run relay + host + pair
                 [--relay-only|--host-only] [--web] [--yes]
  muxr daemon install|uninstall|start|stop|status|logs
  muxr devices list | revoke <number|name>
  muxr integrations sync [--all] [--dry-run]
  muxr integrations uninstall [--dry-run]
  muxr plugin create <name>
  muxr plugin check|dev <path> [--web]
  muxr plugin call <path> <contribution-id> [--input '<json>'] [--context '<json>']
  muxr plugin list
  muxr plugin install <local-path|owner/repo[/subdir][@ref]|npm:<name>@<exact-version>> [--yes]
  muxr plugin update <same-spec> [--yes]
  muxr plugin remove <plugin-id> [--yes]
  muxr doctor
  muxr pair [--browser]       pair a native device or an 8-hour read-only browser
  muxr up [--fake]            run the host in the foreground
  muxr version
`);
    code = command === 'help' || command === '--help' || command === '-h' ? 0 : 1;
}
process.exitCode = code;
