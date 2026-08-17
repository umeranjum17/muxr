#!/usr/bin/env node
import { createRequire } from 'node:module';
import { hasPendingRemoteConnect, runDaemon, runDevices, runDoctor, runIntegrations, runMachines, runPair, runRemoteConnect, runSelfHost } from './local-setup.mjs';
import { runMachineManagement, runRemoteRelaySetup, runSetup, runSharedRelaySetup } from './setup-wizard.mjs';
import { runPlugin } from './plugin.mjs';
import { runPackage } from './package.mjs';
import { runUpdate } from './update.mjs';
import { select } from './setup-ui.mjs';

const HELP = `muxr — every coding agent on your phone

Run muxr with no arguments for the interactive menu.

Get started
  muxr setup                     install, connect, and pair this machine
  muxr doctor                    check the complete local setup
  muxr pair [--browser]          pair another phone or read-only browser
  muxr connect --enrollment ...  connect this agent machine to a shared relay
  muxr shared-relay              host an always-on relay for other machines

Run and maintain
  muxr update [--check|--yes]    check for or install the latest npm release
  muxr self-host [options]       run the relay, host, and pairing flow
  muxr daemon <command>          install, start, stop, restart, or inspect muxr services
  muxr devices list|revoke       list or revoke paired devices
  muxr machines enroll|list|revoke manage machines on a shared relay
  muxr integrations sync|uninstall

Build plugins
  muxr plugin create|check|dev|call|list|install|update|remove

Use “muxr help <command>” for command options.
`;

const COMMAND_HELP = {
    setup: `muxr setup [--inspect] [--dry-run] [--no-agent-config]\n           [--install-herdr|--no-install-herdr] [--port <n>]\n\nInteractive setup lets you choose networking, integrations, plugins, and services, shows a final plan, then applies it and displays a short-lived pairing QR.\n`,
    'self-host': `muxr self-host [--advertise <ws-url>] [--tunnel] [--tailscale-direct]\n               [--port <n>] [--relay-only|--host-only] [--web] [--yes]\n`,
    daemon: `muxr daemon install|uninstall|start|stop|restart|status|logs\n`,
    devices: `muxr devices list\nmuxr devices revoke <number|name>\n`,
    integrations: `muxr integrations sync [--all] [--dry-run]\nmuxr integrations uninstall [--dry-run]\n`,
    plugin: `muxr plugin create <name>\nmuxr plugin check|dev <path> [--web]\nmuxr plugin call <path> <contribution-id> [--input '<json>'] [--context '<json>']\nmuxr plugin list\nmuxr plugin install|update <local-path|owner/repo[/subdir][@ref]|npm:<name>@<exact-version>> [--yes]\nmuxr plugin remove <plugin-id> [--yes]\n`,
    pair: `muxr pair [--browser]\n\nCreate a short-lived pairing QR for another native device or an 8-hour read-only browser.\n`,
    doctor: `muxr doctor\n\nCheck Node, Herdr, integrations, managed files, and the self-host relay without printing secrets.\n`,
    update: `muxr update [--check|--yes]\n\nCheck npm for a newer @trymuxr/cli release. Interactive terminals ask before installing; --yes updates without prompting.\n`,
    connect: `muxr connect --enrollment <muxr://enroll?...> [--no-pair|--pair-browser|--pair-both]\nmuxr connect --resume\n`,
    machines: `muxr machines enroll\nmuxr machines list\nmuxr machines revoke <number|name>\n`,
    'shared-relay': `muxr shared-relay\n\nInteractively configure a supervised VPS relay, optional browser client, and machine enrollments.\n`,
};

function printHelp(command) {
    process.stdout.write(command && COMMAND_HELP[command] ? COMMAND_HELP[command] : HELP);
}

const input = process.argv.slice(2);
let command = input[0];
let args = input.slice(1);
if (command === undefined && process.stdin.isTTY && process.stdout.isTTY) {
    const selected = await select('What would you like to do?', [
        { value: 'setup', title: 'Set up this agent machine', description: 'run a relay here and pair phone or browser' },
        { value: 'connect-remote', title: 'Connect to a shared relay', description: 'paste a one-use enrollment from your relay server' },
        ...(hasPendingRemoteConnect() ? [{ value: 'resume-remote', title: 'Resume remote connection', description: 'finish an enrollment saved before an interrupted setup' }] : []),
        { value: 'shared-relay', title: 'Host or change a shared relay', description: 'run an always-on relay for other agent machines' },
        { value: 'machines-menu', title: 'Manage shared relay machines', description: 'create enrollment, list machines, or revoke access' },
        { value: 'update', title: 'Update muxr', description: 'check npm and install the latest release' },
        { value: 'pair', title: 'Pair another phone', description: 'show a short-lived encrypted pairing QR' },
        { value: 'pair-browser', title: 'Pair a browser', description: 'create an eight-hour read-only browser grant' },
        { value: 'doctor', title: 'Check this setup', description: 'run safe diagnostics without printing secrets' },
        { value: 'restart', title: 'Restart muxr', description: 'restart the supervised relay and host' },
        { value: 'help', title: 'Show commands', description: 'print the non-interactive command reference' },
    ]);
    if (selected === undefined) process.exit(0);
    command = selected;
    if (command === 'connect-remote') command = 'connect-wizard';
    if (command === 'resume-remote') {
        command = 'connect';
        args = ['--resume'];
    }
    if (command === 'restart') {
        command = 'daemon';
        args = ['restart'];
    } else if (command === 'pair-browser') {
        command = 'pair';
        args = ['--browser'];
    }
}
command ??= 'help';
let code = 0;

if (command === 'help' || command === '--help' || command === '-h') {
    printHelp(args[0]);
} else if (args.includes('--help') || args.includes('-h')) {
    printHelp(command);
} else if (command === 'up') {
    await import('./host-up.mjs');
} else if (command === 'setup') {
    code = await runSetup(args);
} else if (command === 'shared-relay') {
    code = await runSharedRelaySetup();
} else if (command === 'connect-wizard') {
    code = await runRemoteRelaySetup();
} else if (command === 'machines-menu') {
    code = await runMachineManagement();
} else if (command === 'connect') {
    code = await runRemoteConnect(args);
} else if (command === 'self-host') {
    code = await runSelfHost(args);
} else if (command === 'devices') {
    const [deviceCommand = 'list', ...deviceArgs] = args;
    code = await runDevices(deviceCommand, deviceArgs);
} else if (command === 'machines') {
    const [machineCommand = 'list', ...machineArgs] = args;
    code = await runMachines(machineCommand, machineArgs);
} else if (command === 'doctor') {
    code = await runDoctor();
} else if (command === 'update') {
    code = await runUpdate(args);
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
