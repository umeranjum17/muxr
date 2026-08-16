import { spawnSync } from 'node:child_process';
import { networkInterfaces } from 'node:os';
import { intro, heading, status, note, outro, select, withSpinner } from './setup-ui.mjs';
import { runBootstrap, runLocalPrerequisites, runSelfHost } from './local-setup.mjs';

function command(name, args = []) {
    const result = spawnSync(name, args, { encoding: 'utf8', timeout: 120_000 });
    return {
        ok: result.status === 0,
        output: (result.stdout || result.stderr || '').trim(),
        missing: result.error?.code === 'ENOENT',
    };
}

function interactiveCommand(name, args = []) {
    const result = spawnSync(name, args, { stdio: 'inherit' });
    return { ok: result.status === 0, output: result.error?.message ?? result.signal ?? '' };
}

function value(args, name) {
    const inline = args.find((arg) => arg.startsWith(`${name}=`));
    if (inline !== undefined) return inline.slice(name.length + 1);
    const index = args.indexOf(name);
    return index >= 0 ? args[index + 1] : undefined;
}

function lanAddress() {
    for (const list of Object.values(networkInterfaces())) {
        for (const entry of list ?? []) {
            if (entry.family === 'IPv4' && !entry.internal) return entry.address;
        }
    }
    return undefined;
}

function integrationSummary(output) {
    const lines = output.split('\n').map((line) => line.trim()).filter(Boolean);
    const current = lines.filter((line) => /:\s+current\b/.test(line)).map((line) => line.split(':', 1)[0]);
    const available = lines.filter((line) => !/:\s+not installed\b/.test(line)).map((line) => line.split(':', 1)[0]);
    return { current, available };
}

export function inspectSetup() {
    const herdrVersion = command('herdr', ['--version']);
    const herdrStatus = herdrVersion.ok ? command('herdr', ['status']) : { ok: false, output: '' };
    const integration = herdrVersion.ok ? command('herdr', ['integration', 'status']) : { ok: false, output: '' };
    const agents = integrationSummary(integration.output);
    const tailscale = command('tailscale', ['ip', '-4']);
    const cloudflared = command('cloudflared', ['--version']);
    return {
        herdr: { installed: herdrVersion.ok, version: herdrVersion.output.split('\n')[0], running: herdrStatus.ok },
        agents,
        tailscale: { installed: !tailscale.missing, connected: tailscale.ok && tailscale.output !== '', ip: tailscale.output.split('\n')[0] },
        cloudflared: { installed: cloudflared.ok },
        lan: lanAddress(),
    };
}

function renderInspection(found) {
    heading('Checking this machine');
    status('Herdr', found.herdr.installed ? found.herdr.version : 'not installed', found.herdr.installed ? 'ok' : 'warn');
    status('Herdr server', found.herdr.running ? 'running' : 'will be started', found.herdr.running ? 'ok' : 'warn');
    status('Agent integrations', `${found.agents.current.length} ready${found.agents.current.length ? ` — ${found.agents.current.slice(0, 5).join(', ')}${found.agents.current.length > 5 ? '…' : ''}` : ''}`, found.agents.current.length ? 'ok' : 'warn');
    status('Tailscale', found.tailscale.connected ? `connected — ${found.tailscale.ip}` : found.tailscale.installed ? 'installed, not connected' : 'not installed', found.tailscale.connected ? 'ok' : 'off');
    status('Cloudflare Tunnel', found.cloudflared.installed ? 'available' : 'not installed', found.cloudflared.installed ? 'ok' : 'off');
    status('Local network', found.lan ?? 'no address found', found.lan ? 'ok' : 'warn');
    process.stdout.write('\n');
}

const RECOMMENDED_PLUGINS = [
    {
        title: 'Name sessions from the task',
        description: 'renames the real Herdr pane · may use Codex · generated worktrees may rename their branch and workspace',
        repo: 'wyattjoh/herdr-plugin-renamer',
        ref: 'b9500f0682a5d76b5a80dd7fd13ba19c1562bc7d',
        pluginId: 'herdr-plugin-renamer',
    },
    {
        title: 'Browse files and diffs',
        description: 'read-only git-aware viewer · smarzban/herdr-file-viewer',
        repo: 'smarzban/herdr-file-viewer',
        ref: 'a2368d701659813938f79e2f1e5aa4e9f4fb2b77',
        pluginId: 'herdr-file-viewer',
    },
    {
        title: 'Review agent changes',
        description: 'comments on diffs and sends approved feedback · persiyanov/herdr-reviewr',
        repo: 'persiyanov/herdr-reviewr',
        ref: '249ec795cfa55e817b882e09c7c2890eeac8e03c',
        pluginId: 'persiyanov.reviewr',
    },
];

const herdr = () => process.env.HERDR_BIN?.trim() || 'herdr';

function installedPlugins() {
    const result = command(herdr(), ['plugin', 'list', '--json']);
    if (!result.ok) return new Set();
    try {
        const parsed = JSON.parse(result.output);
        return new Set((parsed.result?.plugins ?? parsed.plugins ?? []).map((plugin) => plugin.plugin_id));
    } catch { return new Set(); }
}

async function choosePlugins() {
    const installed = installedPlugins();
    const selected = [];
    for (const plugin of RECOMMENDED_PLUGINS) {
        if (installed.has(plugin.pluginId)) {
            status(plugin.title, 'already installed', 'ok');
            continue;
        }
        const choice = await select(`Add ${plugin.title.toLowerCase()}?`, [
            { value: 'skip', title: 'No', description: 'leave Herdr unchanged' },
            { value: 'install', title: 'Yes', description: `${plugin.description} · ${plugin.repo}` },
        ]);
        if (choice === undefined) return undefined;
        if (choice === 'install') selected.push(plugin);
    }
    return selected;
}

async function installPlugins(plugins) {
    for (const plugin of plugins) {
        heading(`Review ${plugin.repo}`);
        const result = interactiveCommand(herdr(), ['plugin', 'install', plugin.repo, '--ref', plugin.ref]);
        if (!result.ok) status(plugin.title, `skipped — ${result.output || 'install failed'}`, 'warn');
        else status(plugin.title, 'installed', 'ok');
    }
}

function choices(found) {
    const options = [];
    if (found.tailscale.connected) {
        options.push({ value: 'tailscale', title: 'Self-host with Tailscale', description: 'recommended · private from anywhere' });
    }
    options.push({ value: 'lan', title: 'Self-host on this network', description: 'phone stays on the same LAN' });
    if (found.cloudflared.installed) {
        options.push({ value: 'cloudflare', title: 'Self-host with Cloudflare Tunnel', description: 'advanced · temporary public tunnel' });
    }
    return options;
}

export async function runSetup(args = []) {
    // Existing automation stays stable: flags used by scripts keep the historical
    // non-wizard flow. Plain `muxr setup` is the high-touch interactive path.
    const requestedMode = value(args, '--mode');
    const automationFlags = ['--headless', '--dry-run', '--no-agent-config', '--install-herdr', '--no-install-herdr', '--force', '--all'];
    const fromPlugin = args.includes('--from-plugin');
    if (fromPlugin && (!process.stdin.isTTY || !process.stdout.isTTY)) {
        process.stderr.write('muxr setup plugin requires an interactive Herdr pane\n');
        return 1;
    }
    const scripted = !fromPlugin && (!process.stdin.isTTY || !process.stdout.isTTY || automationFlags.some((flag) => args.includes(flag)));
    if (scripted) {
        const prerequisites = await runLocalPrerequisites(args);
        if (prerequisites !== 0) return prerequisites;
        return runSelfHost(args);
    }

    intro();
    if (!fromPlugin && !args.includes('--inspect')) {
        const bootstrapped = await runBootstrap(args);
        if (bootstrapped !== 0) return bootstrapped;
        outro('muxr is installed in Herdr. Open the muxr setup plugin to continue.');
        return 0;
    }

    const found = await withSpinner('Inspecting Herdr, agents, and networking', async () => inspectSetup());
    renderInspection(found);
    if (args.includes('--inspect')) {
        outro('Inspection complete. Nothing changed.');
        return 0;
    }

    let mode = requestedMode;
    if (mode === 'selfhost') mode = found.tailscale.connected ? 'tailscale' : 'lan';
    if (!mode) mode = await select('How should this machine connect?', choices(found));
    if (!mode) return 1;

    heading('Optional Herdr add-ons');
    const plugins = await choosePlugins();
    if (plugins === undefined) return 1;

    if (!['tailscale', 'lan', 'cloudflare'].includes(mode)) {
        process.stderr.write(`unknown setup mode: ${mode}\n`);
        return 1;
    }

    note(mode === 'tailscale'
        ? ['Tailscale was detected. No ports will be opened to the public internet.', 'muxr will start Herdr, your agent integrations, the relay, and the host.']
        : mode === 'cloudflare'
            ? ['Cloudflare creates a public relay URL. Payloads remain end-to-end encrypted.', 'Use a named tunnel for a permanent deployment.']
            : ['The relay will be reachable only from this local network.', 'Pair only on a network you trust; agent payloads remain end-to-end encrypted.']);

    const prerequisites = await runLocalPrerequisites(args);
    if (prerequisites !== 0) return prerequisites;
    await installPlugins(plugins);
    const modeIndex = args.indexOf('--mode');
    const dropped = new Set(modeIndex >= 0 ? [modeIndex, modeIndex + 1] : []);
    const selfhostArgs = args.filter((arg, index) => !arg.startsWith('--mode=') && !dropped.has(index) && arg !== '--from-plugin');
    if (mode === 'lan' && found.lan) selfhostArgs.push('--advertise', `ws://${found.lan}:${value(args, '--port') ?? 8792}`);
    if (mode === 'cloudflare') selfhostArgs.push('--tunnel');
    const result = await runSelfHost(selfhostArgs);
    if (result === 0) outro('Paired. Your agents are ready in muxr.');
    return result;
}
