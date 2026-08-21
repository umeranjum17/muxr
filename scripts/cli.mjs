#!/usr/bin/env node
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { browserHostingReady, daemonIsRunning, hasPendingRemoteConnect, runDaemon, runDevices, runDoctor, runIntegrations, runMachines, runPair, runRemoteConnect, runSelfHost } from './local-setup.mjs';
import { runMachineManagement, runRemoteRelaySetup, runSetup, runSharedRelaySetup } from './setup-wizard.mjs';
import { runPlugin } from './plugin.mjs';
import { runPackage } from './package.mjs';
import { runUpdate } from './update.mjs';
import { BACK, heading, prompt, select, status } from './setup-ui.mjs';

const HELP = `muxr — every coding agent on your phone

Run muxr with no arguments for the interactive menu.

Get started
  muxr setup                     install, connect, and pair this machine
  muxr doctor                    check the complete local setup
  muxr pair [--browser]          pair another phone or read-only browser
  muxr connect --enrollment ...  connect this agent machine to a shared relay
  muxr shared-relay              host an always-on relay for other machines

Run and maintain
  muxr status                    check this setup (same as muxr doctor)
  muxr restart                   restart the supervised relay and host
  muxr update [--check|--yes]    check for or install the latest npm release
  muxr uninstall                 remove muxr services and managed files
  muxr self-host [options]       run the relay, host, and pairing flow
  muxr daemon <command>          install, start, stop, restart, or inspect muxr services
  muxr devices list|revoke       list or revoke paired devices
  muxr machines enroll|list|revoke manage machines on a shared relay
  muxr integrations sync|uninstall

Build plugins
  muxr plugin docs|create|clone|check|dev|call|list|sync|reload|install|update|remove

Use “muxr help <command>” for command options.
`;

const COMMAND_HELP = {
    setup: `muxr setup [--inspect] [--dry-run] [--no-agent-config]\n           [--install-herdr|--no-install-herdr] [--port <n>]\n\nInteractive setup lets you choose networking, integrations, plugins, and services, shows a final plan, then applies it and displays a short-lived pairing QR.\n`,
    'self-host': `muxr self-host [--advertise <ws-url>] [--tunnel] [--tailscale-direct]\n               [--port <n>] [--relay-only|--host-only] [--web] [--yes]\n`,
    daemon: `muxr daemon install|uninstall|start|stop|restart|status|logs\n`,
    devices: `muxr devices list\nmuxr devices revoke <number|name>\n`,
    integrations: `muxr integrations sync [--all] [--dry-run]\nmuxr integrations uninstall [--dry-run]\n`,
    plugin: `muxr plugin docs\nmuxr plugin sync [<plugin-id>...] [--check] [--yes]\nmuxr plugin reload <plugin-id>... | --all\nmuxr plugin create <name>\nmuxr plugin clone <bundled-plugin-id> [destination]\nmuxr plugin check|dev <path> [--web]\nmuxr plugin call <path> <contribution-id> [--input '<json>'] [--context '<json>']\nmuxr plugin list\nmuxr plugin install|update <local-path|owner/repo[/subdir][@ref]|npm:<name>@<exact-version>> [--yes]\nmuxr plugin remove <plugin-id> [--yes]\n`,
    'plugin docs': `muxr plugin docs\n\nPrint absolute paths to the installed authoring guide and agent skill.\n`,
    'plugin sync': `muxr plugin sync [<plugin-id>...] [--check] [--yes]\n\nCopy bundled plugins from this checkout over the installed copies and reload them.\nBundled plugins run from the installed npm package, so editing plugins/ in a\ncheckout otherwise changes nothing the host can see. Reports what differs;\n--check reports without writing. An installed copy that was edited after the\nlast sync is never overwritten without asking.\n`,
    'plugin reload': `muxr plugin reload <plugin-id>... | --all\n\nMake connected devices refetch a plugin and restart its stream providers.\nEditing a backend entry file (rpc.mjs, stream.mjs) changes nothing the host\nhashes, so the edit would otherwise never reach the phone.\n`,
    'plugin create': `muxr plugin create <name>\n\nCreate a minimal three-file settings-screen plugin with a collision-resistant local id.\n`,
    'plugin clone': `muxr plugin clone <bundled-plugin-id> [destination]\n\nCopy a package-owned plugin to a user-owned folder, assign a new local id, and print the safe replace workflow.\n`,
    'plugin check': `muxr plugin check <path>\n\nValidate Herdr identity, muxr manifest, slots, primitives, actions, RPCs, and streams without linking.\n`,
    'plugin dev': `muxr plugin dev <path> [--web]\n\nValidate and link a local plugin enabled. --web also starts the source-checkout web client.\n`,
    'plugin call': `muxr plugin call <path> <contribution-id> [--input '<json>'] [--context '<json>']\n\nRun one declared RPC through the same bounded author contract used by the host.\n`,
    'plugin list': `muxr plugin list\n\nList registered plugins, source, version, root, and enabled state.\n`,
    'plugin install': `muxr plugin install <local-path|owner/repo[/subdir][@ref]|npm:<name>@<exact-version>> [--yes]\n\nMaterialize, validate, confirm, and enable a plugin.\n`,
    'plugin update': `muxr plugin update <local-path|owner/repo[/subdir][@ref]|npm:<name>@<exact-version>> [--yes]\n\nReplace plugin files transactionally while preserving its enabled state.\n`,
    'plugin remove': `muxr plugin remove <plugin-id> [--yes]\n\nDisable, unlink, and remove muxr-managed plugin files.\n`,
    pair: `muxr pair [--browser]\n\nCreate a two-minute QR and short pairing string for a native device, or an 8-hour read-only browser grant.\n`,
    doctor: `muxr doctor\n\nCheck Node, Herdr, integrations, managed files, and the self-host relay without printing secrets.\n`,
    status: `muxr status\n\nAlias for muxr doctor.\n`,
    restart: `muxr restart\n\nRestart the supervised relay and host (same as muxr daemon restart).\n`,
    uninstall: `muxr uninstall\n\nRemove muxr services and managed integration files after a confirmation. Herdr, your sessions, and your data stay.\n`,
    update: `muxr update [--check|--yes]\n\nCheck npm for a newer @trymuxr/cli release. Interactive terminals ask before installing; --yes updates without prompting.\n`,
    connect: `muxr connect --enrollment <muxr://enroll?...> [--no-pair|--pair-browser|--pair-both]\nmuxr connect --resume\n`,
    machines: `muxr machines enroll\nmuxr machines list\nmuxr machines revoke <number|name>\n`,
    'shared-relay': `muxr shared-relay\n\nInteractively configure a supervised VPS relay, optional browser client, and machine enrollments.\n`,
};

function printHelp(command) {
    process.stdout.write(command && COMMAND_HELP[command] ? COMMAND_HELP[command] : HELP);
}

function versionString() {
    const require = createRequire(import.meta.url);
    try { return require('./package.json').version; } catch { return require('../package.json').version; }
}

// Cheap local read for the menu only. selfhostPublicSummary() would also probe
// the advertised URL with a 10s timeout; a menu that hangs is worse than a
// menu missing a field, so the public check stays with doctor.
function readMenuState() {
    try {
        const dir = process.env.MUXR_HOME?.trim() || join(process.env.HOME?.trim() || homedir(), '.muxr');
        const parsed = JSON.parse(readFileSync(join(dir, 'selfhost.json'), 'utf8'));
        return parsed?.version === 1 ? parsed : undefined;
    } catch { return undefined; }
}

// Plain-words relay kind for the state block, so running `muxr` teaches the
// model: a host here, and which kind of relay the phone talks through.
const RELAY_KIND = {
    tailscale: 'Tailscale (private)',
    'tailscale-direct': 'Tailscale (direct IP)',
    cloudflare: 'Cloudflare tunnel (temporary public URL)',
    lan: 'LAN (same wifi)',
    external: 'your own server',
};

async function printState() {
    heading(`muxr ${versionString()}`);
    const state = readMenuState();
    if (state === undefined) {
        status('this machine', 'is not set up yet — start with Set up or repair this machine', 'warn');
        process.stdout.write('\n');
        return undefined;
    }
    const local = state.relayLocation !== 'remote';
    let relayHealthy;
    if (local && Number.isInteger(state.relayPort)) {
        relayHealthy = await fetch(`http://127.0.0.1:${state.relayPort}/health`, { signal: AbortSignal.timeout(1500) })
            .then((response) => response.ok).catch(() => false);
    }
    const kind = local ? (RELAY_KIND[state.connectionMode] ?? state.connectionMode) : 'shared relay in the cloud (this host dials out)';
    const relaySummary = [kind, state.relayUrl].filter(Boolean).join(' · ');
    status('relay', local ? `${relaySummary} · ${relayHealthy ? 'running' : 'not responding'}` : relaySummary, local ? (relayHealthy ? 'ok' : 'warn') : 'off');
    if (state.relayRole === 'shared') {
        status('host', 'none — this machine is a shared relay server', 'off');
    } else {
        const running = daemonIsRunning();
        const devices = Array.isArray(state.machine?.crypto?.devices) ? state.machine.crypto.devices.length : 0;
        status('host', running
            ? `running · ${devices} paired device${devices === 1 ? '' : 's'}`
            : 'stopped · start it from Set up or repair this machine', running ? 'ok' : 'warn');
    }
    process.stdout.write('\n');
    return state;
}

const thisIsSharedRelay = () => {
    const state = readMenuState();
    return state?.relayRole === 'shared' && typeof state.mintSecret === 'string';
};

async function runUninstall() {
    const confirmed = await select(
        'Uninstall muxr from this machine? This removes muxr services and managed integration files. Herdr, your sessions, and your data stay.',
        [
            { value: 'cancel', title: 'Cancel', description: 'keep everything as it is' },
            { value: 'yes', title: 'Uninstall', description: 'remove services and managed files' },
        ],
    );
    if (confirmed !== 'yes') return 0;
    let code = await runDaemon(['uninstall']);
    if (code === 0) code = await runIntegrations(['uninstall']);
    if (code === 0) process.stdout.write('\nmuxr services are removed. Finish with: npm uninstall -g @trymuxr/cli\n');
    return code;
}

async function dispatch(command, args = []) {
    if (command === 'help' || command === '--help' || command === '-h') {
        printHelp(args.length > 1 ? `${args[0]} ${args[1]}` : args[0]);
        return 0;
    }
    if (args.includes('--help') || args.includes('-h')) {
        const pluginSubcommand = command === 'plugin' && args[0] && !args[0].startsWith('-') ? args[0] : undefined;
        printHelp(pluginSubcommand ? `plugin ${pluginSubcommand}` : command);
        return 0;
    }
    if (command === 'up') {
        await import('./host-up.mjs');
        return 0;
    }
    if (command === 'setup') return runSetup(args);
    if (command === 'shared-relay') return runSharedRelaySetup();
    if (command === 'connect-wizard') return runRemoteRelaySetup();
    if (command === 'machines-menu') return runMachineManagement();
    if (command === 'connect') return runRemoteConnect(args);
    if (command === 'self-host') return runSelfHost(args);
    if (command === 'devices') {
        const [deviceCommand = 'list', ...deviceArgs] = args;
        return runDevices(deviceCommand, deviceArgs);
    }
    if (command === 'machines') {
        const [machineCommand = 'list', ...machineArgs] = args;
        return runMachines(machineCommand, machineArgs);
    }
    if (command === 'doctor' || command === 'status') return runDoctor();
    if (command === 'update') return runUpdate(args);
    if (command === 'daemon') return runDaemon(args);
    if (command === 'restart') return runDaemon(['restart']);
    if (command === 'uninstall') return runUninstall();
    if (command === 'integrations') return runIntegrations(args);
    if (command === 'plugin') {
        const [pluginCommand = 'list', ...pluginArgs] = args;
        try {
            return ['docs', 'create', 'clone', 'check', 'call', 'dev'].includes(pluginCommand)
                ? runPlugin(pluginCommand, pluginArgs)
                : await runPackage(pluginCommand, pluginArgs);
        } catch (error) {
            process.stderr.write(`muxr plugin: ${error instanceof Error ? error.message : String(error)}\n`);
            return 1;
        }
    }
    if (command === 'pair') return runPair(args);
    if (command === 'version' || command === '--version' || command === '-v') {
        process.stdout.write(`${versionString()}\n`);
        return 0;
    }
    process.stderr.write(`Unknown command: ${command}\n\n`);
    printHelp();
    return 1;
}

// Ctrl-c returns "quit" to the main loop; back/esc returns one menu level.
async function repairMenu() {
    for (;;) {
        const choice = await select('Set up or repair this machine', [
            ...(hasPendingRemoteConnect() ? [{ value: 'resume', title: 'Resume remote connection', description: 'finish an enrollment saved before an interrupted setup' }] : []),
            { value: 'doctor', title: 'Check this setup', description: 'run safe diagnostics without printing secrets' },
            { value: 'setup', title: 'Change networking and integrations', description: 'inspect, review the plan, then apply' },
            { value: 'restart', title: 'Restart services', description: 'restart the supervised relay and host' },
            { value: 'update', title: 'Update muxr', description: 'check npm and install the latest release' },
            { value: 'uninstall', title: 'Uninstall muxr', description: 'remove muxr services and managed files; keep Herdr and your data' },
            { value: 'back', title: 'Back', description: 'return to the main menu' },
        ]);
        if (choice === undefined) return 'quit';
        if (choice === BACK || choice === 'back') return;
        const code = choice === 'resume' ? await dispatch('connect', ['--resume']) : await dispatch(choice, []);
        if (code !== 0) process.exitCode = code;
    }
}

async function devicesMenu() {
    for (;;) {
        const choice = await select('Phones and browsers', [
            { value: 'pair', title: 'Pair a phone', description: 'show a two-minute QR and short pairing string' },
            { value: 'pair-browser', title: 'Pair a browser', description: 'create an eight-hour read-only browser grant' },
            { value: 'list', title: 'List paired devices', description: 'names and pairing dates' },
            { value: 'revoke', title: 'Revoke a device', description: 'disconnect a phone or browser' },
            { value: 'back', title: 'Back', description: 'return to the main menu' },
        ]);
        if (choice === undefined) return 'quit';
        if (choice === BACK || choice === 'back') return;
        let code = 0;
        if (choice === 'pair') code = await runPair([]);
        else if (choice === 'pair-browser') {
            if (!browserHostingReady()) {
                const enable = await select(
                    'Browser hosting is off. It needs a secure HTTPS endpoint (Tailscale Serve, Cloudflare, or your own WSS) and is turned on during setup.',
                    [
                        { value: 'setup', title: 'Open setup', description: 'enable browser hosting with a reviewed plan' },
                        { value: 'back', title: 'Back', description: 'return without changing anything' },
                    ],
                    1,
                );
                if (enable === undefined) return 'quit';
                if (enable === 'setup') code = await dispatch('setup', []);
            } else code = await runPair(['--browser']);
        } else if (choice === 'list') code = await runDevices('list');
        else if (choice === 'revoke') {
            code = await runDevices('list');
            if (code === 0) {
                const reference = await prompt('Device list number or exact name');
                if (reference === undefined) return 'quit';
                if (reference) code = await runDevices('revoke', [reference]);
            }
        }
        if (code !== 0) process.exitCode = code;
    }
}

async function relayMenu() {
    for (;;) {
        const choice = await select('Other machines and shared relay', [
            // Opposite directions: the first makes THIS box the relay, the
            // second keeps this box the host and dials out to one.
            { value: 'host', title: 'Host a shared relay here', description: 'this computer becomes the always-on relay that other machines dial out to' },
            { value: 'connect', title: 'Connect this machine to a relay', description: 'this computer stays the host and dials out to a relay running elsewhere' },
            // Machine management only works on the relay server itself; offering
            // it elsewhere was a dead end that threw after two more picks.
            ...(thisIsSharedRelay() ? [
                { value: 'enroll', title: 'Create enrollment', description: 'show a five-minute, one-use string for an agent machine' },
                { value: 'list', title: 'List machines', description: 'show friendly names and credential expiry' },
                { value: 'revoke', title: 'Revoke a machine', description: 'disconnect its host and every paired device' },
            ] : []),
            { value: 'back', title: 'Back', description: 'return to the main menu' },
        ]);
        if (choice === undefined) return 'quit';
        if (choice === BACK || choice === 'back') return;
        let code = 0;
        if (choice === 'host') code = await runSharedRelaySetup();
        else if (choice === 'connect') code = await runRemoteRelaySetup();
        else if (choice === 'enroll' || choice === 'list') code = await runMachines(choice);
        else if (choice === 'revoke') {
            code = await runMachines('list');
            if (code === 0) {
                const reference = await prompt('Machine list number or exact name');
                if (reference === undefined) return 'quit';
                if (reference) code = await runMachines('revoke', [reference]);
            }
        }
        if (code !== 0) process.exitCode = code;
    }
}

const input = process.argv.slice(2);
if (input[0] === undefined && process.stdin.isTTY && process.stdout.isTTY) {
    for (;;) {
        const state = await printState();
        const selected = await select('What would you like to do?', [
            { value: 'repair', title: hasPendingRemoteConnect() ? 'Resume interrupted setup' : 'Set up or repair this machine', description: 'networking, services, diagnostics, updates' },
            ...(state !== undefined ? [{ value: 'devices', title: 'Phones and browsers', description: 'pair a new one, or see and revoke what is paired' }] : []),
            { value: 'relay', title: 'Other machines and shared relay', description: 'this box becomes the relay, or its host dials out to one elsewhere' },
            { value: 'help', title: 'Show commands', description: 'print the non-interactive command reference' },
            { value: 'quit', title: 'Quit' },
        ]);
        if (selected === undefined || selected === BACK || selected === 'quit') break;
        if (selected === 'help') {
            printHelp();
            continue;
        }
        const result = selected === 'repair' ? await repairMenu()
            : selected === 'devices' ? await devicesMenu()
                : await relayMenu();
        if (result === 'quit') break;
    }
} else {
    // argv-supplied commands run once and keep their own exit code.
    const code = await dispatch(input[0] ?? 'help', input.slice(1));
    process.exitCode = code;
}
