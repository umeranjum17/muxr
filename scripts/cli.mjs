#!/usr/bin/env node
import { createRequire } from 'node:module';
import { runDaemon, runDevices, runDoctor, runIntegrations, runPair, runSelfHost } from './local-setup.mjs';
import { runSetup } from './setup-wizard.mjs';
import { runPlugin } from './plugin.mjs';
import { runPackage } from './package.mjs';

const HELP = `muxr — every coding agent on your phone

Get started
  muxr setup                     install, connect, and pair this machine
  muxr doctor                    check the complete local setup
  muxr pair [--browser]          pair another phone or read-only browser

Run and maintain
  muxr self-host [options]       run the relay, host, and pairing flow
  muxr daemon <command>          install, start, stop, inspect, or remove the host
  muxr devices list|revoke       list or revoke paired devices
  muxr integrations sync|uninstall

Build plugins
  muxr plugin create|check|dev|call|list|install|update|remove

Use “muxr help <command>” for command options.
`;

const COMMAND_HELP = {
    setup: `muxr setup [--inspect] [--dry-run] [--no-agent-config]\n           [--install-herdr|--no-install-herdr] [--port <n>]\n\nGuided setup adopts or installs Herdr, syncs integrations, starts the self-hosted relay and host, then shows a short-lived pairing QR.\n`,
    'self-host': `muxr self-host [--advertise <ws-url>] [--tunnel] [--tailscale-direct]\n               [--port <n>] [--relay-only|--host-only] [--web] [--yes]\n`,
    daemon: `muxr daemon install|uninstall|start|stop|status|logs\n`,
    devices: `muxr devices list\nmuxr devices revoke <number|name>\n`,
    integrations: `muxr integrations sync [--all] [--dry-run]\nmuxr integrations uninstall [--dry-run]\n`,
    plugin: `muxr plugin create <name>\nmuxr plugin check|dev <path> [--web]\nmuxr plugin call <path> <contribution-id> [--input '<json>'] [--context '<json>']\nmuxr plugin list\nmuxr plugin install|update <local-path|owner/repo[/subdir][@ref]|npm:<name>@<exact-version>> [--yes]\nmuxr plugin remove <plugin-id> [--yes]\n`,
    pair: `muxr pair [--browser]\n\nCreate a short-lived pairing QR for another native device or an 8-hour read-only browser.\n`,
    doctor: `muxr doctor\n\nCheck Node, Herdr, integrations, managed files, and the self-host relay without printing secrets.\n`,
};

function printHelp(command) {
    process.stdout.write(command && COMMAND_HELP[command] ? COMMAND_HELP[command] : HELP);
}

const input = process.argv.slice(2);
const command = input[0] ?? 'help';
const args = input.slice(1);
let code = 0;

if (command === 'help' || command === '--help' || command === '-h') {
    printHelp(args[0]);
} else if (args.includes('--help') || args.includes('-h')) {
    printHelp(command);
} else if (command === 'up') {
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
    code = await runPair(args);
} else if (command === 'version' || command === '--version' || command === '-v') {
    const require = createRequire(import.meta.url);
    let pkg;
    try { pkg = require('./package.json'); } catch { pkg = require('../package.json'); }
    process.stdout.write(`${pkg.version}\n`);
} else {
    process.stderr.write(`Unknown command: ${command}\n\n`);
    printHelp();
    code = 1;
}
process.exitCode = code;
