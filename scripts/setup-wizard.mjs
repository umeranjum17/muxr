import { spawnSync } from 'node:child_process';
import { networkInterfaces } from 'node:os';
import { intro, heading, status, note, outro, prompt, select, withSpinner } from './setup-ui.mjs';
import { runDoctor, runLocalPrerequisites, runPair, runSelfHost, selfhostPublicSummary } from './local-setup.mjs';

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
    const tailscaleStatus = tailscale.ok ? command('tailscale', ['status', '--json']) : { ok: false, output: '' };
    let tailscaleDns;
    try { tailscaleDns = JSON.parse(tailscaleStatus.output).Self?.DNSName?.replace(/\.$/, ''); }
    catch { tailscaleDns = undefined; }
    const cloudflared = command('cloudflared', ['--version']);
    return {
        herdr: { installed: herdrVersion.ok, version: herdrVersion.output.split('\n')[0], running: herdrStatus.ok },
        agents,
        tailscale: { installed: !tailscale.missing, connected: tailscale.ok && tailscale.output !== '', ip: tailscale.output.split('\n')[0], dnsName: tailscaleDns },
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
    const installed = [];
    const failed = [];
    for (const plugin of plugins) {
        heading(`Review ${plugin.repo}`);
        const result = interactiveCommand(herdr(), ['plugin', 'install', plugin.repo, '--ref', plugin.ref]);
        if (!result.ok) {
            failed.push(plugin);
            status(plugin.title, `skipped — ${result.output || 'install failed'}`, 'warn');
        } else {
            installed.push(plugin);
            status(plugin.title, 'installed', 'ok');
        }
    }
    return { installed, failed };
}

function choices(found) {
    const options = [];
    if (found.tailscale.connected) {
        options.push({ value: 'tailscale', title: 'Tailscale Serve', description: 'recommended · private tailnet HTTPS/WSS' });
        options.push({ value: 'tailscale-direct', title: 'Direct Tailscale IP', description: 'advanced · connect to the tailnet address and port' });
    }
    if (found.lan) options.push({ value: 'lan', title: 'Local network', description: 'phone stays on the same trusted LAN' });
    options.push({ value: 'external', title: 'External URL for this relay', description: 'reverse proxy or domain pointing back to this machine' });
    if (found.cloudflared.installed) {
        options.push({ value: 'cloudflare', title: 'Cloudflare quick tunnel', description: 'temporary public HTTPS/WSS endpoint' });
    }
    return options;
}

function connectionLabel(mode, endpoint, port) {
    if (mode === 'tailscale') return `Tailscale Serve on local port ${port}`;
    if (mode === 'tailscale-direct') return `Direct Tailscale on port ${port}`;
    if (mode === 'lan') return `Trusted LAN on port ${port}`;
    if (mode === 'cloudflare') return `Cloudflare quick tunnel to local port ${port}`;
    return `External ${endpoint}`;
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
    if (args.includes('--inspect')) {
        intro();
        const found = await withSpinner('Inspecting Herdr, agents, and networking', async () => inspectSetup());
        renderInspection(found);
        outro('Inspection complete. Nothing changed.');
        return 0;
    }
    if (scripted) {
        const prerequisites = await runLocalPrerequisites(args);
        if (prerequisites !== 0) return prerequisites;
        return runSelfHost(args);
    }

    intro();
    const found = await withSpinner('Inspecting Herdr, agents, and networking', async () => inspectSetup());
    renderInspection(found);
    const current = await selfhostPublicSummary();

    let mode = requestedMode;
    if (mode === 'selfhost') mode = undefined;
    if (!mode) {
        const connectionChoices = choices(found).map((choice) => choice.value === current?.connectionMode
            ? { ...choice, title: `${choice.title} · current` }
            : choice);
        const initial = Math.max(0, connectionChoices.findIndex((choice) => choice.value === current?.connectionMode));
        mode = await select('How should this machine connect?', connectionChoices, initial);
    }
    if (!mode) return 0;
    if (!['tailscale', 'tailscale-direct', 'lan', 'external', 'cloudflare'].includes(mode)) {
        process.stderr.write(`unknown setup mode: ${mode}\n`);
        return 1;
    }
    if ((mode === 'tailscale' || mode === 'tailscale-direct') && !found.tailscale.connected) {
        process.stderr.write('Tailscale is not connected; choose Local network or External URL for this relay\n');
        return 1;
    }
    if (mode === 'lan' && !found.lan) {
        process.stderr.write('no local network address was found; choose another connection method\n');
        return 1;
    }
    if (mode === 'cloudflare' && !found.cloudflared.installed) {
        process.stderr.write('cloudflared is not installed; choose another connection method\n');
        return 1;
    }

    let port;
    while (port === undefined) {
        const portText = await prompt('Local relay port', value(args, '--port') ?? String(current?.relayPort ?? 8792));
        if (portText === undefined) return 0;
        const parsed = Number(portText);
        if (Number.isInteger(parsed) && parsed >= 1024 && parsed <= 65535) port = parsed;
        else status('Relay port', 'enter an integer from 1024 to 65535', 'warn');
    }
    let endpoint;
    if (mode === 'external') {
        while (endpoint === undefined) {
            const entered = await prompt('External relay URL (wss://...)', current?.connectionMode === 'external' ? current.relayUrl : '');
            if (entered === undefined) return 0;
            try {
                const parsed = new URL(entered);
                if (parsed.protocol === 'wss:' && parsed.hostname && !parsed.username && !parsed.password && parsed.pathname === '/' && !parsed.search && !parsed.hash) endpoint = parsed.toString().replace(/\/$/, '');
                else status('External relay URL', 'use a root wss://host URL without credentials, query, or fragment', 'warn');
            } catch {
                status('External relay URL', 'use a valid wss:// URL', 'warn');
            }
        }
    }

    const secureWebMode = ['tailscale', 'external', 'cloudflare'].includes(mode);
    const web = secureWebMode
        ? await select('Host the read-only browser client too?', [
            { value: false, title: 'Native app only', description: 'do not expose the browser client' },
            { value: true, title: 'Host the browser client', description: 'serve it over the selected HTTPS/WSS connection' },
        ], current?.webEnabled ? 1 : 0)
        : false;
    if (web === undefined) return 0;
    if (!secureWebMode) status('Browser client', 'requires Tailscale Serve, External WSS, or Cloudflare; native app only', 'off');
    const desiredUrl = mode === 'lan' ? `ws://${found.lan}:${port}`
        : mode === 'external' ? endpoint
            : mode === 'tailscale-direct' ? `ws://${found.tailscale.ip}:${port}`
                : mode === 'tailscale' && found.tailscale.dnsName ? `wss://${found.tailscale.dnsName}`
                    : mode === 'cloudflare'
                        && current?.connectionMode === 'cloudflare'
                        && current.relayPort === port
                        && current.webEnabled === web
                        && current.ingressHealthy === true
                        ? current.relayUrl
                        : undefined;
    const connectionChanged = current === undefined || desiredUrl === undefined || current.relayUrl !== desiredUrl;
    const pairingChoices = [
        ...(!connectionChanged ? [{ value: 'none', title: 'Keep paired devices', description: 'no new QR; existing devices keep working' }] : []),
        { value: 'phone', title: 'Phone', description: 'pair the native app first' },
        ...(web ? [
            { value: 'browser', title: 'Browser', description: 'pair one read-only browser for eight hours' },
            { value: 'both', title: 'Phone, then browser', description: 'complete both pairing steps' },
        ] : []),
    ];
    const pairing = await select(connectionChanged ? 'The endpoint changed. Which client should pair again?' : 'Pair another client?', pairingChoices);
    if (pairing === undefined) return 0;

    const installHerdr = found.herdr.installed ? false : await select('Herdr is required. Install it during setup?', [
        { value: false, title: 'Cancel setup', description: 'leave this machine unchanged' },
        { value: true, title: 'Install Herdr', description: 'download the public installer, then verify the installation' },
    ]);
    if (!found.herdr.installed && installHerdr !== true) return 0;

    const syncIntegrations = await select('Sync the detected coding-agent integrations?', [
        { value: true, title: 'Sync detected integrations', description: `${found.agents.available.length} available · keeps lifecycle status current` },
        { value: false, title: 'Leave integrations unchanged', description: 'do not install or alter coding-agent hooks' },
    ]);
    if (syncIntegrations === undefined) return 0;

    heading('Optional Herdr add-ons');
    const plugins = await choosePlugins();
    if (plugins === undefined) return 0;

    heading('Review setup');
    note([
        `Connection: ${connectionLabel(mode, endpoint, port)}`,
        `Herdr: ${found.herdr.installed ? 'adopt existing installation and ensure its server is running' : 'download, install, and start after your explicit selection'}`,
        'Bundled plugins: link the public muxr plugins into Herdr',
        `Agent integrations: ${syncIntegrations ? 'sync detected providers and managed instruction blocks' : 'leave hooks and instruction files unchanged'}`,
        `Optional add-ons: ${plugins.length ? plugins.map((plugin) => plugin.title).join(', ') : 'none'}`,
        `Browser client: ${web ? 'host read-only web app; browser keys stay WebCrypto-wrapped on this device' : 'off'}`,
        `Pairing: ${pairing === 'none' ? 'keep existing devices; no new pairing' : pairing === 'both' ? 'phone, then browser' : pairing}${pairing === 'browser' || pairing === 'both' ? ' · browser access is read-only for eight hours' : ''}`,
        `Ingress: ${mode === 'tailscale' ? 'persist a muxr-owned Tailscale Serve route' : mode === 'cloudflare' ? 'start a tracked temporary Cloudflare tunnel' : mode === 'external' ? 'bind loopback for your external reverse proxy' : 'no proxy or public tunnel changes'}`,
        'Services: register or restart the relay and host with systemd/launchd',
        `Existing connections: ${connectionChanged ? 'the public endpoint changes, so every previously paired device needs a fresh pairing link' : 'keep working; restart only if a reviewed runtime setting changed'}`,
        'No change is made until you choose Apply setup.',
    ]);
    const apply = await select('Apply this setup?', [
        { value: false, title: 'Cancel', description: 'leave this machine unchanged' },
        { value: true, title: 'Apply setup', description: 'make the reviewed changes, verify health, then show the pairing QR' },
    ]);
    if (apply !== true) {
        outro('Cancelled. Nothing changed.');
        return 0;
    }

    const prerequisiteArgs = [
        ...args.filter((arg) => arg !== '--from-plugin'),
        ...(found.herdr.installed ? [] : ['--install-herdr']),
        ...(syncIntegrations ? [] : ['--no-integrations']),
    ];
    const prerequisites = await runLocalPrerequisites(prerequisiteArgs);
    if (prerequisites !== 0) return prerequisites;
    const pluginResult = await installPlugins(plugins);
    const selfhostArgs = ['--port', String(port), '--connection-mode', mode, '--reconfigure'];
    if (mode === 'lan') selfhostArgs.push('--advertise', `ws://${found.lan}:${port}`);
    if (mode === 'external') selfhostArgs.push('--advertise', endpoint);
    if (mode === 'cloudflare') selfhostArgs.push('--tunnel');
    if (mode === 'tailscale-direct') selfhostArgs.push('--tailscale-direct');
    if (web) selfhostArgs.push('--web', '--yes');
    if (pairing === 'browser') selfhostArgs.push('--pair-browser');
    if (pairing === 'none') selfhostArgs.push('--no-pair');
    const result = await runSelfHost(selfhostArgs);
    if (result !== 0) return result;
    const browserPairFailed = pairing === 'both' && (await runPair(['--browser'])) !== 0;
    const doctor = await runDoctor();
    if (doctor !== 0) return doctor;
    const summary = await selfhostPublicSummary();
    heading('Setup complete');
    note([
        `Connection: ${connectionLabel(mode, endpoint, port)}`,
        'Relay location: this machine',
        `Relay URL: ${summary?.relayUrl ?? 'unavailable'}`,
        `Web URL: ${summary?.webUrl ?? 'off'}`,
        `Relay service: ${summary?.relayHealthy ? 'running' : 'check required'}`,
        `Host service: ${summary?.hostRunning ? 'running' : 'check required'}`,
        `Herdr: ${found.herdr.running ? 'running' : 'started during setup'}`,
        `Integrations: ${syncIntegrations ? 'selected providers synced' : 'unchanged'}`,
        `Pairing: ${pairing === 'none' ? 'existing devices kept' : browserPairFailed ? 'phone paired; browser pairing failed' : pairing === 'both' ? 'phone and browser paired' : `${pairing} paired`}${!browserPairFailed && (pairing === 'browser' || pairing === 'both') ? ' · browser expires in eight hours' : ''}`,
        `Plugins: bundled${pluginResult.installed.length ? ` + ${pluginResult.installed.map((plugin) => plugin.title).join(', ')}` : ''}`,
        ...(pluginResult.failed.length ? [`Plugin install failed: ${pluginResult.failed.map((plugin) => plugin.title).join(', ')}`] : []),
        'Configuration: ~/.muxr (owner-only)',
    ]);
    outro(pairing === 'none'
        ? 'Setup updated. Existing devices will reconnect automatically.'
        : 'Paired. Open muxr on your phone, or run `muxr` anytime to change these choices.');
    return browserPairFailed ? 1 : 0;
}
