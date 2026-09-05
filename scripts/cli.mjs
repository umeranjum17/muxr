#!/usr/bin/env node
import { createRequire } from 'node:module';
import { existsSync, realpathSync, readdirSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, relative } from 'node:path';
import { homedir, release as kernelRelease } from 'node:os';
import { fileURLToPath } from 'node:url';
import {
    BACK,
    applyMachineSetup,
    browserHostingCanEnable,
    browserHostingReady,
    connectEnrollment,
    connectRemoteRelay,
    daemonIsRunning,
    daemonMode,
    enableBrowserHosting,
    hasPendingRemoteConnect,
    heading,
    hostSharedRelay,
    inspectSetup,
    listDevices,
    listMachines,
    manageMachines,
    pairDevice,
    prompt,
    revokeDevice,
    revokeMachine,
    enrollMachine,
    runDaemon,
    runIntegrations,
    runPeers,
    select,
    startSelfHost,
    status,
    uninstallMuxr,
} from './setup/index.mjs';
import {
    callPluginAction,
    clonePlugin,
    createPlugin,
    installPlugin,
    linkPlugin,
    listPlugins,
    removePlugin,
    reportPluginCheck,
    showPluginDocs,
    updatePlugin,
} from './plugin/index.mjs';
import { dumpDiagnostics, readDiagnostics } from './diagnostics/index.mjs';
import { updateCli } from './release/index.mjs';

const HELP = `muxr — every coding agent on your phone

Run muxr with no arguments for the interactive menu.

Get started
  muxr setup                     install, connect, and pair this machine
  muxr doctor                    check the complete local setup
  muxr diagnostics               show bounded redacted host history for agents
  muxr report                    prepare a local redacted bug report draft
  muxr pair [--browser|--browser-view] pair a phone or control/view-only browser
  muxr connect --enrollment ...  connect this agent machine to a shared relay
  muxr shared-relay              host an always-on relay for other machines

Run and maintain
  muxr status                    check this setup (same as muxr doctor)
  muxr restart                   restart the supervised relay and host
  muxr update [--check|--yes]    update within the installed release channel
              [--channel dev|beta|stable] [--to VERSION] [--allow-downgrade]
  muxr uninstall [--yes]         fully remove muxr; keep Herdr and repositories
  muxr self-host [options]       run the relay, host, and pairing flow
  muxr daemon <command>          install, start, stop, restart, or inspect muxr services
  muxr devices list|revoke       list or revoke paired devices
  muxr machines enroll|list|revoke manage machines on a shared relay
  muxr peers list|read|status|watch|prompt use established computer collaboration
  muxr integrations sync|uninstall

Agent instructions
  muxr --skill | muxr skill       print the compact muxr agent skill
  muxr skill <topic>              load one reference only when needed

Build plugins
  muxr plugin docs|create|clone|check|dev|call|list|install|update|remove

Use “muxr help <command>” for command options.
`;

const COMMAND_HELP = {
    setup: `muxr setup [--inspect] [--dry-run] [--no-install-herdr] [--port <n>]\n\nInteractive setup installs Herdr when missing, lets you choose networking, lifecycle integrations, plugins, and services, shows a final plan, then applies it and displays a short-lived pairing QR. It never installs agent skills or edits prompt files.\n`,
    'self-host': `muxr self-host [--advertise <ws-url>] [--tunnel] [--tailscale-direct]\n               [--port <n>] [--relay-only|--host-only] [--web] [--yes]\n`,
    daemon: `muxr daemon install|uninstall|start|stop|restart|status|logs\n\n\`install\` writes or updates the background-service definition without starting it. Normal \`muxr setup\` installs, starts, and verifies the service for you.\n`,
    devices: `muxr devices list\nmuxr devices revoke <number|name>\n`,
    integrations: `muxr integrations sync [--all] [--dry-run]\nmuxr integrations uninstall [--dry-run]\n\nSync Herdr lifecycle integrations only. Agent skills and prompt files are never changed.\n`,
    plugin: `muxr plugin docs\nmuxr plugin create <name>\nmuxr plugin clone <bundled-plugin-id> [destination]\nmuxr plugin check|dev <path> [--web]\nmuxr plugin call <path> <contribution-id> [--input '<json>'] [--context '<json>']\nmuxr plugin list\nmuxr plugin install|update <local-path|owner/repo[/subdir][@ref]|npm:<name>@<exact-version>> [--yes]\nmuxr plugin remove <plugin-id> [--yes]\n`,
    'plugin docs': `muxr plugin docs\n\nPrint absolute paths to the installed authoring guide and agent skill.\n`,
    'plugin create': `muxr plugin create <name>\n\nCreate a minimal three-file settings-screen plugin with a collision-resistant local id.\n`,
    'plugin clone': `muxr plugin clone <bundled-plugin-id> [destination]\n\nCopy a package-owned plugin to a user-owned folder, assign a new local id, and print the safe replace workflow.\n`,
    'plugin check': `muxr plugin check <path>\n\nValidate Herdr identity, muxr manifest, slots, primitives, actions, RPCs, and streams without linking.\n`,
    'plugin dev': `muxr plugin dev <path> [--web]\n\nValidate and link a local plugin enabled. --web also starts the source-checkout web client.\n`,
    'plugin call': `muxr plugin call <path> <contribution-id> [--input '<json>'] [--context '<json>']\n\nRun one declared RPC through the same bounded author contract used by the host.\n`,
    'plugin list': `muxr plugin list\n\nList registered plugins, source, version, root, and enabled state.\n`,
    'plugin install': `muxr plugin install <local-path|owner/repo[/subdir][@ref]|npm:<name>@<exact-version>> [--yes]\n\nMaterialize, validate, confirm, and enable a plugin.\n`,
    'plugin update': `muxr plugin update <local-path|owner/repo[/subdir][@ref]|npm:<name>@<exact-version>> [--yes]\n\nReplace plugin files transactionally while preserving its enabled state.\n`,
    'plugin remove': `muxr plugin remove <plugin-id> [--yes]\n\nDisable, unlink, and remove muxr-managed plugin files.\n`,
    pair: `muxr pair [--browser|--browser-view]\n\nCreate a two-minute native QR/string, an eight-hour control-browser link (--browser), or an eight-hour view-only browser link (--browser-view).\n`,
    doctor: `muxr doctor\n\nCheck Node, Herdr, integrations, managed files, and the self-host relay without printing secrets.\n`,
    diagnostics: `muxr diagnostics\n\nPrint seven days of bounded redacted host, client, relay, collaboration, and broker history as JSON. No prompts, terminal output, paths, secrets, or internal ids are recorded.\n`,
    report: `muxr report > muxr-report.md\n\nPrepare a local GitHub issue draft with environment versions, redacted doctor check names, and the latest 50 bounded diagnostic events. The command only prints a draft. Review every line, add what happened, and explicitly decide whether to post it; muxr never opens or submits an issue.\n`,
    status: `muxr status\n\nAlias for muxr doctor.\n`,
    restart: `muxr restart\n\nRestart the supervised relay and host (same as muxr daemon restart).\n`,
    uninstall: `muxr uninstall [--yes|--resume]\n\nRemove all muxr-owned services, ingress, identity, pairings, grants, relay/plugin state, provider keys, logs, caches, and managed integrations. Herdr, its sessions, repositories, worktrees, exports, signing keys, and unrecognized files stay. The globally installed CLI can be removed last.\n`,
    update: `muxr update [--check|--yes]\n\nCheck npm for a newer @trymuxr/cli release. --to VERSION selects an exact published version; changing channels or downgrading remains explicit. Interactive terminals ask before installing; --yes updates without prompting.\n`,
    skill: `muxr --skill\nmuxr skill\nmuxr skill <onboarding|herdr|collaboration|browser-takeover|plugins>\nmuxr skill all\n\nPrint the compact canonical skill by default. Load one focused reference on demand; muxr skill all prints the archival self-contained bundle. Herdr guidance comes from the installed binary when available. No files or state are changed.\n`,
    peers: `muxr peers list [--machine <name>]\nmuxr peers read --machine <name> [--agent <name>] [--lines <n>]\nmuxr peers status --machine <name> [--agent <name>]\nmuxr peers watch --machine <name> [--agent <name>] [--timeout-ms <n>]\nmuxr peers prompt --machine <name> [--agent <name>] --text <prompt>\n\nUse established computer collaboration with Machine Names and Agent Names only. Output is JSON. Raw shell, takeover, and destructive actions are never granted.\n`,
    connect: `muxr connect --enrollment <muxr://enroll?...> [--no-pair|--pair-browser|--pair-browser-view|--pair-both]\nmuxr connect --resume\n`,
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

function commandVersion(command) {
    const result = spawnSync(command, ['--version'], { encoding: 'utf8', timeout: 5_000 });
    return `${result.stdout ?? ''}\n${result.stderr ?? ''}`.match(/\b\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?\b/)?.[0] ?? 'unavailable';
}

function operatingSystem() {
    if (process.platform !== 'linux' || !existsSync('/etc/os-release')) return `${process.platform} ${process.arch} · kernel ${kernelRelease()}`;
    const value = readFileSync('/etc/os-release', 'utf8').match(/^PRETTY_NAME=(.*)$/m)?.[1]?.trim();
    const name = value?.replace(/^"|"$/g, '') || 'Linux';
    return `${name} ${process.arch} · kernel ${kernelRelease()}`;
}

function issueReport() {
    const doctor = spawnSync(process.execPath, [realpathSync(process.argv[1]), 'doctor'], {
        encoding: 'utf8',
        timeout: 90_000,
        env: { ...process.env, MUXR_NO_TUI: '1' },
    });
    const checks = `${doctor.stdout ?? ''}\n${doctor.stderr ?? ''}`.split('\n').flatMap((line) => {
        const match = line.match(/^\s*(ok|warn|FAIL)\s{2,}(.+?)\s{2,}/);
        return match ? [`- ${match[1].toUpperCase()} ${match[2].trim()}`] : [];
    });
    if (checks.length === 0) checks.push(`- UNAVAILABLE ${doctor.error?.code === 'ETIMEDOUT' ? 'doctor timed out after 90 seconds' : 'doctor returned no checks'}`);

    let diagnostics;
    try {
        const state = readDiagnostics();
        diagnostics = JSON.stringify({
            ...state,
            note: `${state.note}; report includes the latest 50 events only`,
            events: state.events.slice(-50).map(({
                requestedAgentName: _requestedAgentName,
                resolvedAgentName: _resolvedAgentName,
                ...event
            }) => event),
        }, null, 2);
    } catch (cause) {
        diagnostics = JSON.stringify({ unavailable: cause instanceof Error ? cause.message : String(cause) }, null, 2);
    }

    process.stdout.write(`<!-- DRAFT ONLY: muxr never opens or submits an issue.\nReview every line for sensitive information. If an agent generated this draft, it must show it to the user and ask whether they want to post it before taking any external action.\n-->\n## What happened\n\n<!-- What did you do, what did you expect, and what happened instead? -->\n\n## Steps to reproduce\n\n1. \n\n## Expected behavior\n\n<!-- What should muxr have done? -->\n\n## Environment\n\n- muxr: ${versionString()}\n- Node: ${process.version}\n- OS: ${operatingSystem()}\n- Mode: ${daemonMode() ?? 'not configured'}\n- Herdr: ${commandVersion('herdr')}\n- Tailscale: ${commandVersion('tailscale')}\n\n## Health summary\n\nDoctor ${doctor.status === 0 ? 'completed without blocking failures' : 'found blocking problems or could not finish'}:\n\n${checks.join('\n')}\n\n## Redacted diagnostics\n\n\`\`\`json\n${diagnostics}\n\`\`\`\n`);
}

function muxrSkillDirectory() {
    const here = dirname(fileURLToPath(import.meta.url));
    const packaged = join(here, 'skills', 'muxr');
    return existsSync(join(packaged, 'SKILL.md')) ? packaged : join(here, '..', 'skills', 'muxr');
}

function installedHerdrReference() {
    const binary = process.env.HERDR_BIN?.trim() || 'herdr';
    const skill = spawnSync(binary, ['--skill'], { encoding: 'utf8' });
    if (skill.status !== 0 || !skill.stdout?.startsWith('---')) return undefined;
    const body = skill.stdout.replace(/^---\n[\s\S]*?\n---\n?/, '').trim();
    if (!body) return undefined;
    const version = spawnSync(binary, ['--version'], { encoding: 'utf8' });
    return `## Installed Herdr CLI reference\n\nGenerated by \`herdr --skill\` from \`${version.status === 0 ? version.stdout.trim() : 'the installed Herdr binary'}\`.\n\n${body}`;
}

const SKILL_TOPICS = {
    onboarding: 'onboarding.md',
    herdr: 'herdr.md',
    collaboration: 'collaboration.md',
    'browser-takeover': 'browser-takeover.md',
    browser: 'browser-takeover.md',
    plugins: 'plugins.md',
};

function skillReference(root, name) {
    const packaged = readFileSync(join(root, 'references', name), 'utf8').trimEnd();
    const herdr = name === 'herdr.md' ? installedHerdrReference() : undefined;
    return herdr ? `${packaged}\n\n${herdr}` : packaged;
}

function printSkill(topic) {
    const root = muxrSkillDirectory();
    if (!topic) {
        process.stdout.write(`${readFileSync(join(root, 'SKILL.md'), 'utf8').trimEnd()}\n`);
        return;
    }
    if (topic !== 'all') {
        const name = SKILL_TOPICS[topic];
        if (!name) throw new Error(`Unknown skill topic: ${topic}`);
        process.stdout.write(`${skillReference(root, name)}\n`);
        return;
    }
    const references = readdirSync(join(root, 'references'), { withFileTypes: true })
        .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
        .map((entry) => entry.name)
        .sort();
    let output = readFileSync(join(root, 'SKILL.md'), 'utf8').trimEnd();
    for (const name of references) output += `\n\n<!-- muxr-skill-reference: references/${name} -->\n\n${skillReference(root, name)}`;
    process.stdout.write(`${output}\n`);
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
    private: 'private network',
    cloudflare: 'Cloudflare tunnel (temporary public URL)',
    lan: 'LAN (same wifi)',
    external: 'your own server',
};

async function printState() {
    heading(`muxr ${versionString()}`);
    const state = readMenuState();
    if (state === undefined) {
        status('this machine', 'is not set up yet — choose Set up this machine', 'warn');
        process.stdout.write('\n');
        return undefined;
    }
    const local = state.relayLocation !== 'remote';
    let relayHealthy;
    if (local && Number.isInteger(state.relayPort)) {
        relayHealthy = await fetch(`http://127.0.0.1:${state.relayPort}/health`, { signal: AbortSignal.timeout(1500) })
            .then((response) => response.ok).catch(() => false);
    }
    const kind = local
        ? (RELAY_KIND[state.connectionMode] ?? state.connectionMode)
        : 'shared relay in the cloud (this host dials out)';
    const relaySummary = [kind, state.relayUrl].filter(Boolean).join(' · ');
    if (!local) {
        status('relay', relaySummary, 'off');
    } else {
        const health = relayHealthy ? 'running' : 'not responding';
        status('relay', `${relaySummary} · ${health}`, relayHealthy ? 'ok' : 'warn');
    }
    if (state.relayRole === 'shared') {
        status('host', 'none — this machine is a shared relay server', 'off');
    } else {
        const running = daemonIsRunning();
        const devices = Array.isArray(state.machine?.crypto?.devices) ? state.machine.crypto.devices.length : 0;
        status('host', running
            ? `running · ${devices} paired device${devices === 1 ? '' : 's'}`
            : 'stopped · start it from Repair or change setup', running ? 'ok' : 'warn');
    }
    process.stdout.write('\n');
    return state;
}

const thisIsSharedRelay = () => {
    const state = readMenuState();
    return state?.relayRole === 'shared' && typeof state.mintSecret === 'string';
};

function globalCliPrefix() {
    const npm = process.env.MUXR_NPM_BIN?.trim() || 'npm';
    const result = spawnSync(npm, ['prefix', '--global'], { encoding: 'utf8' });
    if (result.status !== 0) return undefined;
    const prefix = result.stdout.trim();
    const cli = realpathSync(process.argv[1]);
    const packageRoot = join(prefix, 'lib', 'node_modules', '@trymuxr', 'cli');
    return relative(packageRoot, cli).startsWith('..') ? undefined : { npm, prefix };
}

async function runUninstall(args = []) {
    const assumeYes = args.includes('--yes') || args.includes('--resume');
    if (!assumeYes) {
        const confirmed = await select(
            'Fully uninstall muxr from this computer? Machine identity, pairings, grants, provider keys, runtime state, services, ingress, and muxr-managed plugins will be permanently removed. Herdr, its sessions, repositories, worktrees, received attachments, exports, signing keys, and unrecognized files stay.',
            [
                { value: 'cancel', title: 'Cancel', description: 'leave this computer unchanged' },
                { value: 'yes', title: 'Fully uninstall muxr', description: 'remove every muxr-owned operational component' },
            ],
        );
        if (confirmed !== 'yes') return 0;
    }

    const code = await uninstallMuxr(args);
    if (code !== 0) return code;
    const global = globalCliPrefix();
    if (global === undefined) return 0;
    const removePackage = assumeYes || await select('Remove the muxr CLI package too?', [
        { value: true, title: 'Remove @trymuxr/cli', description: 'finish the full uninstall' },
        { value: false, title: 'Keep the command installed', description: 'the next muxr run starts fresh setup' },
    ]);
    if (removePackage !== true) return 0;
    process.stdout.write('\nRemoving @trymuxr/cli…\n');
    const removed = spawnSync(global.npm, ['uninstall', '--global', '--ignore-scripts', '@trymuxr/cli'], { stdio: 'inherit' });
    if (removed.status !== 0) {
        process.stderr.write('Runtime state was removed, but npm could not remove @trymuxr/cli. Run `npm uninstall -g @trymuxr/cli`.\n');
        return 1;
    }
    process.stdout.write('@trymuxr/cli was removed. Reinstall later with `npm install -g --ignore-scripts @trymuxr/cli`.\n');
    return 0;
}

async function applyUpdate(args = []) {
    const targetIndex = args.indexOf('--to');
    if (targetIndex !== -1 && (!args[targetIndex + 1] || args[targetIndex + 1].startsWith('--'))) {
        process.stderr.write('--to requires an exact published version\n');
        return 1;
    }
    const channelIndex = args.indexOf('--channel');
    if (channelIndex !== -1 && !args[channelIndex + 1]) {
        process.stderr.write('--channel requires dev, beta or stable\n');
        return 1;
    }
    return updateCli({
        checkOnly: args.includes('--check'),
        yes: args.includes('--yes'),
        channel: channelIndex === -1 ? undefined : args[channelIndex + 1],
        targetVersion: targetIndex === -1 ? undefined : args[targetIndex + 1],
        allowDowngrade: args.includes('--allow-downgrade'),
        confirm: process.stdin.isTTY && process.stdout.isTTY
            ? async ({ latest }) => select('Apply this update?', [
                { value: false, title: 'Not now', description: 'leave this installation unchanged' },
                { value: true, title: 'Update muxr', description: `install @trymuxr/cli@${latest} and apply the plan above` },
            ])
            : undefined,
    });
}

function pluginFlag(args, name) {
    const index = args.indexOf(name);
    if (index !== -1) {
        if (index === args.length - 1) throw new Error(`${name} requires a JSON value`);
        return args[index + 1];
    }
    const inline = args.find((arg) => arg.startsWith(`${name}=`));
    return inline?.slice(name.length + 1);
}

async function dispatchPlugin(command, args = []) {
    if (command === 'docs') {
        if (args.length !== 0) throw new Error('muxr plugin docs takes no arguments');
        return showPluginDocs();
    }
    if (command === 'clone') {
        if (!args[0] || args.length > 2) throw new Error('muxr plugin clone requires a plugin id and optional destination');
        return clonePlugin(args[0], args[1]);
    }
    if (command === 'call') {
        const positional = [];
        for (let index = 0; index < args.length; index += 1) {
            if (args[index] === '--input' || args[index] === '--context') { index += 1; continue; }
            if (args[index].startsWith('--input=') || args[index].startsWith('--context=')) continue;
            positional.push(args[index]);
        }
        const [path, contributionId] = positional;
        if (!path || !contributionId) throw new Error('muxr plugin call requires a path and a contribution id');
        return callPluginAction(path, contributionId, pluginFlag(args, '--input'), pluginFlag(args, '--context'));
    }
    if (command === 'list') return listPlugins(args);
    if (command === 'install') return installPlugin(args);
    if (command === 'update') return updatePlugin(args);
    if (command === 'remove') return removePlugin(args);
    const web = args.includes('--web');
    const path = args.find((arg) => arg !== '--web');
    if (!path) throw new Error(`muxr plugin ${command} requires a path or name`);
    if (web && command !== 'dev') throw new Error('--web is only valid with muxr plugin dev');
    if (command === 'create') return createPlugin(path);
    if (command === 'check') return reportPluginCheck(path);
    if (command === 'dev') return linkPlugin(path, { web });
    throw new Error(`unknown plugin command: ${command}`);
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
    if (command === '--skill' || command === 'skill') {
        try {
            if (args.length > 1) throw new Error('skill accepts one topic');
            printSkill(args[0]);
            return 0;
        } catch (error) {
            process.stderr.write(`muxr skill: ${error instanceof Error ? error.message : String(error)}\n`);
            return 1;
        }
    }
    if (command === 'up') {
        await import('./setup/presentation/hostUp.mjs');
        return 0;
    }
    if (command === 'setup') return applyMachineSetup(args);
    if (command === 'shared-relay') return hostSharedRelay();
    if (command === 'connect-wizard') return connectRemoteRelay();
    if (command === 'machines-menu') return manageMachines();
    if (command === 'connect') return connectEnrollment(args);
    if (command === 'self-host') return startSelfHost(args);
    if (command === 'devices') {
        const [deviceCommand = 'list', ...deviceArgs] = args;
        if (deviceCommand === 'list') return listDevices();
        if (deviceCommand === 'revoke') return revokeDevice(deviceArgs);
        process.stderr.write('usage: muxr devices list | muxr devices revoke <number|name>\n');
        return 1;
    }
    if (command === 'machines') {
        const [machineCommand = 'list', ...machineArgs] = args;
        if (machineCommand === 'enroll') return enrollMachine();
        if (machineCommand === 'list') return listMachines();
        if (machineCommand === 'revoke') return revokeMachine(machineArgs);
        process.stderr.write('usage: muxr machines enroll | list | revoke <number|name>\n');
        return 1;
    }
    if (command === 'peers' || command === 'peer') {
        try {
            await runPeers(args);
            return 0;
        } catch (error) {
            process.stderr.write(`muxr peers: ${error instanceof Error ? error.message : String(error)}\n`);
            return 1;
        }
    }
    if (command === 'doctor' || command === 'status') return inspectSetup();
    if (command === 'diagnostics') {
        try { dumpDiagnostics(); return 0; }
        catch (error) { process.stderr.write(`muxr diagnostics: ${error instanceof Error ? error.message : String(error)}\n`); return 1; }
    }
    if (command === 'report') {
        try { issueReport(); return 0; }
        catch (error) { process.stderr.write(`muxr report: ${error instanceof Error ? error.message : String(error)}\n`); return 1; }
    }
    if (command === 'update') return applyUpdate(args);
    if (command === 'daemon') return runDaemon(args);
    if (command === 'restart') return runDaemon(['restart']);
    if (command === 'uninstall') return runUninstall(args);
    if (command === 'integrations') return runIntegrations(args);
    if (command === 'plugin') {
        const [pluginCommand = 'list', ...pluginArgs] = args;
        try {
            return await dispatchPlugin(pluginCommand, pluginArgs);
        } catch (error) {
            process.stderr.write(`muxr plugin: ${error instanceof Error ? error.message : String(error)}\n`);
            return 1;
        }
    }
    if (command === 'pair') return pairDevice(args);
    if (command === 'version' || command === '--version' || command === '-v') {
        process.stdout.write(`${versionString()}\n`);
        return 0;
    }
    process.stderr.write(`Unknown command: ${command}\n\n`);
    printHelp();
    return 1;
}

// Ctrl-c returns "quit" to the main loop; back/esc returns one menu level.
async function advancedMenu() {
    for (;;) {
        const choice = await select('Advanced', [
            { value: 'restart', title: 'Restart muxr services', description: 'briefly disconnect devices; keep pairings, keys, settings, and integrations' },
            { value: 'relay', title: 'Shared relay and other computers', description: 'advanced multi-computer hosting, enrollment, and revocation' },
            { value: 'help', title: 'Show commands', description: 'print the non-interactive command reference' },
            { value: 'uninstall', title: 'Fully uninstall muxr', description: 'remove muxr runtime, identity, keys, and managed files; keep Herdr and user files' },
            { value: 'back', title: 'Back', description: 'return to the main menu' },
        ]);
        if (choice === undefined) return 'quit';
        if (choice === BACK || choice === 'back') return;
        if (choice === 'help') { printHelp(); continue; }
        if (choice === 'relay') {
            const result = await relayMenu();
            if (result === 'quit') return 'quit';
            continue;
        }
        const code = await dispatch(choice, []);
        if (code !== 0) process.exitCode = code;
        if (choice === 'uninstall' && code === 0) return 'quit';
    }
}

async function devicesMenu() {
    for (;;) {
        const choice = await select('Phones and browsers', [
            { value: 'pair', title: 'Pair a phone', description: 'show a two-minute QR and short pairing string' },
            { value: 'pair-browser', title: 'Pair a control browser', description: 'full terminal and agent control for eight hours' },
            { value: 'pair-browser-view', title: 'Pair a view-only browser', description: 'observe agents without control for eight hours' },
            { value: 'list', title: 'List paired devices', description: 'names and pairing dates' },
            { value: 'revoke', title: 'Revoke a device', description: 'disconnect a phone or browser' },
            { value: 'back', title: 'Back', description: 'return to the main menu' },
        ]);
        if (choice === undefined) return 'quit';
        if (choice === BACK || choice === 'back') return;
        let code = 0;
        if (choice === 'pair') code = await pairDevice([]);
        else if (choice === 'pair-browser' || choice === 'pair-browser-view') {
            if (!browserHostingReady()) {
                const targeted = browserHostingCanEnable();
                const enable = await select(
                    targeted
                        ? 'Enable browser access on the current secure connection? muxr keeps the relay URL, port, phone pairings, integrations, and plugins; it enables the web client and restarts once.'
                        : 'Browser access needs a secure HTTPS connection. Change setup to Tailscale Serve or your own WSS endpoint, then pair the browser.',
                    targeted ? [
                        { value: 'enable', title: 'Enable and pair browser', description: 'keep current settings; enable web, restart once, verify, then create the link' },
                        { value: 'back', title: 'Back', description: 'leave this computer unchanged' },
                    ] : [
                        { value: 'setup', title: 'Change connection', description: 'review a secure connection before enabling browser access' },
                        { value: 'back', title: 'Back', description: 'leave this computer unchanged' },
                    ],
                );
                if (enable === undefined) return 'quit';
                if (enable === 'enable') {
                    code = await enableBrowserHosting();
                    if (code === 0) code = await pairDevice([choice === 'pair-browser-view' ? '--browser-view' : '--browser']);
                } else if (enable === 'setup') code = await dispatch('setup', []);
            } else code = await pairDevice([choice === 'pair-browser-view' ? '--browser-view' : '--browser']);
        } else if (choice === 'list') code = await listDevices();
        else if (choice === 'revoke') {
            code = await listDevices();
            if (code === 0) {
                const reference = await prompt('Device list number or exact name');
                if (reference === undefined) return 'quit';
                if (reference) code = await revokeDevice([reference]);
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
        if (choice === 'host') code = await hostSharedRelay();
        else if (choice === 'connect') code = await connectRemoteRelay();
        else if (choice === 'enroll') code = await enrollMachine();
        else if (choice === 'list') code = await listMachines();
        else if (choice === 'revoke') {
            code = await listMachines();
            if (code === 0) {
                const reference = await prompt('Machine list number or exact name');
                if (reference === undefined) return 'quit';
                if (reference) code = await revokeMachine([reference]);
            }
        }
        if (code !== 0) process.exitCode = code;
    }
}

const input = process.argv.slice(2);
if (input[0] === undefined && process.stdin.isTTY && process.stdout.isTTY) {
    for (;;) {
        const state = await printState();
        const sharedRelay = state?.relayRole === 'shared';
        const serviceStopped = state !== undefined && !daemonIsRunning();
        const selected = await select('What would you like to do?', state === undefined ? [
            ...(hasPendingRemoteConnect() ? [{ value: 'resume', title: 'Resume interrupted setup', description: 'finish the saved remote-relay enrollment' }] : []),
            { value: 'setup', title: 'Set up this computer', description: 'install prerequisites, choose a connection, and pair your phone' },
            { value: 'relay', title: 'Advanced setup', description: 'host a shared relay or connect this computer to one running elsewhere' },
            { value: 'help', title: 'Show commands', description: 'print the non-interactive command reference' },
            { value: 'quit', title: 'Quit' },
        ] : [
            ...(serviceStopped ? [{ value: 'start', title: 'Start muxr services', description: sharedRelay ? 'start the shared relay and keep it running after login' : 'start the relay and agent host, then keep them running after login' }] : []),
            ...(!sharedRelay ? [{ value: 'devices', title: 'Pair or manage devices', description: 'pair a phone or browser, list devices, or revoke access' }] : []),
            ...(sharedRelay ? [{ value: 'machines', title: 'Manage agent computers', description: 'create enrollment, list computers, or revoke one' }] : []),
            { value: 'doctor', title: 'Check setup', description: 'run read-only diagnostics; nothing is changed' },
            { value: 'change', title: sharedRelay ? 'Change shared relay' : 'Change connection and integrations', description: sharedRelay ? 'review public connection, browser hosting, and relay service changes' : 'review networking, browser hosting, coding-agent lifecycle detection, and plugins' },
            { value: 'update', title: 'Update muxr', description: 'check npm first; install only after confirmation' },
            { value: 'advanced', title: 'Advanced', description: 'restart, shared relays, command reference, and full uninstall' },
            { value: 'quit', title: 'Quit' },
        ]);
        if (selected === undefined || selected === BACK || selected === 'quit') break;
        let result;
        if (selected === 'resume') result = await dispatch('connect', ['--resume']);
        else if (selected === 'setup') result = await dispatch('setup', []);
        else if (selected === 'start') result = await runDaemon(['start']);
        else if (selected === 'devices') result = await devicesMenu();
        else if (selected === 'relay') result = await relayMenu();
        else if (selected === 'machines') result = await manageMachines();
        else if (selected === 'doctor' || selected === 'update') result = await dispatch(selected, []);
        else if (selected === 'change') result = sharedRelay ? await hostSharedRelay() : await dispatch('setup', []);
        else if (selected === 'advanced') result = await advancedMenu();
        else { printHelp(); continue; }
        if (result === 'quit') break;
        if (typeof result === 'number' && result !== 0) process.exitCode = result;
    }
} else {
    // argv-supplied commands run once and keep their own exit code.
    const code = await dispatch(input[0] ?? 'help', input.slice(1));
    process.exitCode = code;
}
