import { spawnSync } from 'node:child_process';
import { networkInterfaces, userInfo } from 'node:os';
import { intro, heading, status, note, outro, prompt, select, withSpinner, withFullscreen, setupStep, completeFullscreen, BACK } from './ui.mjs';
import { herdrServerIsReady, runLocalPrerequisites } from '../infrastructure/herdr.mjs';
import { inspectSetup } from '../application/inspectSetup.mjs';
import { pairDevice } from '../application/pairDevice.mjs';
import { startSelfHost } from '../application/startSelfHost.mjs';
import { connectEnrollment } from '../application/connectEnrollment.mjs';
import { enrollMachine } from '../application/enrollMachine.mjs';
import { listMachines } from '../application/listMachines.mjs';
import { revokeMachine } from '../application/revokeMachine.mjs';
import { selfhostPublicSummary, sharedMachineCount } from '../infrastructure/selfhostRelay.mjs';
import { inspectTailscaleServeRoot, runTailscale, tailscaleBin } from '../infrastructure/selfhost.mjs';
import { advertisedUrlForMode, connectionLabel, ingressPlan, modeAllowsBrowserHosting } from '../domain/dist/index.js';

function command(name, args = []) {
    const result = spawnSync(name, args, { encoding: 'utf8', timeout: 15_000 });
    const stdout = result.stdout?.trim() ?? '';
    const stderr = result.stderr?.trim() ?? '';
    return {
        ok: result.status === 0 && result.error === undefined,
        output: result.status === 0 ? stdout : stderr || stdout || result.error?.message || '',
        missing: result.error?.code === 'ENOENT',
        errorCode: result.error?.code,
    };
}

function interactiveCommand(name, args = []) {
    const result = spawnSync(name, args, { stdio: 'inherit', timeout: 300_000 });
    return { ok: result.status === 0, output: result.error?.message ?? result.signal ?? '' };
}

function pairingChoiceLabel(pairing) {
    if (pairing === 'none') return 'keep existing devices; no new pairing';
    if (pairing === 'both') return 'phone, then control browser';
    return pairing;
}

function pairingReceiptLabel(pairing, browserPairFailed) {
    if (pairing === 'none') return 'existing devices kept';
    if (browserPairFailed) return 'phone paired; browser pairing failed';
    if (pairing === 'both') return 'phone and control browser paired';
    return `${pairing} paired`;
}

function browserGrantNote(pairing, { planned = false, failed = false } = {}) {
    const browserPair = pairing === 'browser' || pairing === 'browser-view' || pairing === 'both';
    if (!browserPair || failed) return '';
    if (planned) return ' · browser access expires after eight hours';
    return ' · browser expires in eight hours';
}

function value(args, name) {
    const inline = args.find((arg) => arg.startsWith(`${name}=`));
    if (inline !== undefined) return inline.slice(name.length + 1);
    const index = args.indexOf(name);
    return index >= 0 ? args[index + 1] : undefined;
}

const privateIpv4 = (address) => /^10\./.test(address)
    || /^192\.168\./.test(address)
    || /^172\.(?:1[6-9]|2\d|3[01])\./.test(address);
const overlayIpv4 = (address) => {
    const match = address.match(/^100\.(\d+)\./);
    return match !== null && Number(match[1]) >= 64 && Number(match[1]) <= 127;
};
const overlayProvider = (name) => {
    if (/^(?:wt|netbird|nb)/i.test(name)) return 'NetBird';
    if (/^wg/i.test(name)) return 'WireGuard';
    if (/^zt/i.test(name)) return 'ZeroTier';
    return 'private network';
};

export function classifyNetworkRoutes(interfaces = networkInterfaces()) {
    const routes = { private: undefined, lan: undefined };
    for (const [name, list] of Object.entries(interfaces)) {
        for (const entry of list ?? []) {
            if (entry.family !== 'IPv4' || entry.internal || /^tailscale/i.test(name)) continue;
            const overlay = /^(?:wt|netbird|nb|wg|zt|tun|tap)/i.test(name) || overlayIpv4(entry.address);
            if (overlay && routes.private === undefined) routes.private = { address: entry.address, interface: name, provider: overlayProvider(name) };
            if (!overlay && routes.lan === undefined && privateIpv4(entry.address)
                && !/^(?:docker|br-|veth|virbr|podman|lxc|vbox|vmnet|hyperv|wsl)/i.test(name)) routes.lan = entry.address;
        }
    }
    return routes;
}

function integrationSummary(result) {
    const lines = result.output.split('\n').map((line) => line.trim()).filter(Boolean);
    const current = lines.filter((line) => /:\s+current\b/.test(line)).map((line) => line.split(':', 1)[0]);
    const available = lines.filter((line) => !/:\s+not installed\b/.test(line)).map((line) => line.split(':', 1)[0]);
    return { current, available, checked: result.ok, error: result.ok ? undefined : lines[0] || 'herdr integration status failed' };
}

const TAILSCALE_INSTALL_URL = 'https://tailscale.com/download';
const TAILSCALE_UP_HINT = process.platform === 'darwin' ? 'open Tailscale and sign in' : 'sudo tailscale up --operator=$USER';
const CLOUDFLARED_INSTALL_URL = 'https://github.com/cloudflare/cloudflared/releases';

// One probe: `tailscale status --json` carries the IP, DNS name, and backend
// state, so a logged-out or stopped node is reported as such instead of the
// blanket "installed, not connected".
function probeTailscale() {
    const probe = runTailscale(['status', '--json'], { encoding: 'utf8' });
    const result = {
        ok: probe.status === 0,
        output: (probe.stdout || probe.stderr || '').trim(),
        missing: probe.error?.code === 'ENOENT',
        errorCode: probe.error?.code,
    };
    if (result.missing) return { installed: false, connected: false, detail: `not installed — ${TAILSCALE_INSTALL_URL}` };
    let parsed;
    try { parsed = JSON.parse(result.output); } catch { parsed = undefined; }
    const backend = typeof parsed?.BackendState === 'string' ? parsed.BackendState : undefined;
    const dnsName = parsed?.Self?.DNSName?.replace(/\.$/, '') || undefined;
    const ips = Array.isArray(parsed?.Self?.TailscaleIPs) ? parsed.Self.TailscaleIPs.filter((ip) => typeof ip === 'string') : [];
    const ip = ips.find((candidate) => candidate.includes('.'));
    const connected = result.ok && backend === 'Running' && ip !== undefined;
    if (connected) return { installed: true, connected, ip, dnsName, backend };
    let reason;
    if (backend !== undefined && backend !== 'Running') reason = `backend state ${backend}`;
    else if (result.errorCode !== undefined) reason = `tailscale status failed (${result.errorCode})`;
    else if (result.ok) reason = 'no tailnet address assigned yet';
    else reason = result.output.split('\n')[0] || 'tailscale status failed';
    return { installed: true, connected: false, ip, dnsName, backend, detail: `${reason} — try ${TAILSCALE_UP_HINT}` };
}

function probeCloudflared() {
    const result = command('cloudflared', ['--version']);
    if (result.missing) return { installed: false, ok: false, detail: `not installed — ${CLOUDFLARED_INSTALL_URL}` };
    // errorCode means the binary never ran (spawn error), not an exit status.
    const reason = result.errorCode !== undefined
        ? `could not run (${result.errorCode})`
        : (result.output.split('\n')[0] || 'version check failed');
    const detail = result.ok ? undefined : `installed, not working — ${reason} · reinstall: ${CLOUDFLARED_INSTALL_URL}`;
    return { installed: true, ok: result.ok, detail };
}

export function probeMachine() {
    const binary = herdr();
    const herdrVersion = command(binary, ['--version']);
    const integration = herdrVersion.ok ? command(binary, ['integration', 'status']) : { ok: false, output: '' };
    const agents = integrationSummary(integration);
    const routes = classifyNetworkRoutes();
    const tailscale = probeTailscale();
    return {
        herdr: { installed: !herdrVersion.missing, working: herdrVersion.ok, version: herdrVersion.output.split('\n')[0], running: herdrVersion.ok && herdrServerIsReady(binary) },
        agents,
        tailscale,
        cloudflared: probeCloudflared(),
        private: routes.private?.address === tailscale.ip ? undefined : routes.private,
        lan: routes.lan,
    };
}

function agentIntegrationDetail(found) {
    if (!found.agents.checked) return `availability check failed — ${found.agents.error}; run \`muxr doctor\``;
    if (found.agents.current.length === 0) return '0 ready';
    const shown = found.agents.current.slice(0, 5).join(', ');
    const extra = found.agents.current.length > 5 ? '…' : '';
    return `${found.agents.current.length} ready — ${shown}${extra}`;
}

function renderInspection(found) {
    heading('Checking this machine');
    let herdrDetail = 'not installed — will be installed during setup';
    if (found.herdr.installed) herdrDetail = found.herdr.working
        ? found.herdr.version
        : `installed but unavailable — ${found.herdr.version || 'run muxr doctor'}`;
    status('Herdr', herdrDetail, found.herdr.working ? 'ok' : 'warn');
    status('Herdr server', found.herdr.running ? 'running' : 'will be started', found.herdr.running ? 'ok' : 'warn');
    status('Agent integrations', agentIntegrationDetail(found), found.agents.checked && found.agents.current.length ? 'ok' : 'warn');
    status('Tailscale', found.tailscale.connected ? `connected — ${found.tailscale.ip}` : found.tailscale.detail, found.tailscale.connected ? 'ok' : 'off');
    if (found.private) status('Private network', `${found.private.provider} on ${found.private.interface} — ${found.private.address}`, 'ok');
    status('Cloudflare Tunnel', found.cloudflared.ok ? 'available' : found.cloudflared.detail, found.cloudflared.ok ? 'ok' : 'off');
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
        setupStep(3, 5, 'Optional Herdr add-ons');
        const choice = await select(`Add ${plugin.title.toLowerCase()}?`, [
            { value: 'skip', title: 'No', description: 'leave Herdr unchanged' },
            { value: 'install', title: 'Yes', description: `${plugin.description} · ${plugin.repo}` },
        ]);
        if (aborted(choice)) return undefined;
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

// Plain-words name for a connection mode, used anywhere the topology is stated.
const RELAY_KIND = {
    tailscale: 'Tailscale (private)',
    'tailscale-direct': 'Tailscale (direct IP)',
    private: 'your private network',
    cloudflare: 'a temporary Cloudflare tunnel',
    lan: 'your LAN (same wifi only)',
    external: 'your own server',
};
const relayKind = (mode) => RELAY_KIND[mode] ?? mode;

function choices(found, tailscalePlanned = false, serveRoot = { status: 'inconclusive' }) {
    const options = [];
    const serveOccupied = serveRoot.status === 'occupied';
    const serveDisabled = serveRoot.status === 'disabled';
    if (found.tailscale.connected || tailscalePlanned) {
        let serveDescription = 'private HTTPS · works from anywhere';
        if (serveOccupied) serveDescription = 'already used by another service · left unchanged';
        else if (serveDisabled) serveDescription = serveRoot.reason;
        options.push({
            value: 'tailscale',
            title: 'Tailscale Serve',
            description: serveDescription,
            disabled: serveOccupied || serveDisabled,
        });
        options.push({
            value: 'tailscale-direct',
            title: 'Direct Tailscale',
            description: tailscalePlanned ? 'connect during Apply · use the private tailnet address' : 'use the private tailnet address · does not require Serve',
        });
    } else {
        options.push({ value: 'tailscale', title: 'Tailscale', description: found.tailscale.detail, disabled: true });
    }
    if (found.private) {
        options.push({
            value: 'private',
            title: found.private.provider === 'private network' ? 'Private network' : `${found.private.provider} private network`,
            description: `${found.private.interface} · phone must join the same private network`,
        });
    }
    if (found.lan) {
        options.push({ value: 'lan', title: 'Same Wi-Fi', description: 'works now · phone and computer must use the same trusted network' });
    } else {
        options.push({ value: 'lan', title: 'Same Wi-Fi', description: 'no usable local-network address found', disabled: true });
    }
    if (found.cloudflared.ok) {
        options.push({ value: 'cloudflare', title: 'Temporary Cloudflare tunnel', description: 'create a temporary public HTTPS URL during Apply' });
    } else {
        options.push({ value: 'cloudflare', title: 'Temporary Cloudflare tunnel', description: found.cloudflared.detail, disabled: true });
    }
    options.push({ value: 'external', title: 'Your own server', description: 'use an existing stable wss:// relay address' });
    return options;
}

export function recommendedConnection(found, current, tailscalePlanned, serveRoot) {
    if (current?.relayHealthy && current?.publicHealthy
        && ['tailscale', 'tailscale-direct', 'private', 'lan', 'external', 'cloudflare'].includes(current.connectionMode)) {
        return { mode: current.connectionMode, title: connectionLabel(current.connectionMode, current.relayUrl, current.relayPort), description: 'already configured and reachable' };
    }
    if (found.tailscale.connected || tailscalePlanned) {
        const direct = serveRoot.status === 'occupied' || serveRoot.status === 'disabled';
        return direct
            ? { mode: 'tailscale-direct', title: 'Direct Tailscale', description: 'private tailnet route · Tailscale Serve is not required' }
            : { mode: 'tailscale', title: 'Tailscale Serve', description: tailscalePlanned ? 'connect Tailscale during Apply, then create private HTTPS access' : 'private access from anywhere · nothing exposed publicly' };
    }
    if (found.private) return {
        mode: 'private',
        title: `${found.private.provider} on ${found.private.interface}`,
        description: 'use the private network already connected to this computer',
    };
    if (found.cloudflared.ok) return { mode: 'cloudflare', title: 'Temporary Cloudflare tunnel', description: 'create a temporary public HTTPS route during Apply' };
    if (found.lan) return { mode: 'lan', title: 'Same Wi-Fi', description: 'works now while the phone and computer use this trusted network' };
    return undefined;
}

const aborted = (value) => value === undefined || value === BACK;

export function continueWithDirectTailscale(plan) {
    const browserPair = plan.pairing === 'browser' || plan.pairing === 'browser-view' || plan.pairing === 'both';
    return {
        mode: 'tailscale-direct',
        port: plan.port,
        endpoint: plan.endpoint,
        web: false,
        pairing: browserPair ? 'phone' : plan.pairing,
    };
}

export function selfhostArgsFromSetupPlan({ mode, port, web, pairing, found, endpoint }) {
    const selfhostArgs = ['--port', String(port), '--connection-mode', mode, '--reconfigure'];
    if (mode === 'lan') selfhostArgs.push('--advertise', `ws://${found.lan}:${port}`);
    if (mode === 'private') selfhostArgs.push('--advertise', endpoint ?? `ws://${found.private.address}:${port}`);
    if (mode === 'external') selfhostArgs.push('--advertise', endpoint);
    if (mode === 'cloudflare') selfhostArgs.push('--tunnel');
    if (mode === 'tailscale-direct') selfhostArgs.push('--tailscale-direct');
    if (web) selfhostArgs.push('--web', '--yes');
    if (pairing === 'browser') selfhostArgs.push('--pair-browser');
    if (pairing === 'browser-view') selfhostArgs.push('--pair-browser-view');
    if (pairing === 'none') selfhostArgs.push('--no-pair');
    return selfhostArgs;
}

function serveRootFor(found, port) {
    if (!found.tailscale.connected && !found.tailscale.dnsName) return { status: 'inconclusive' };
    return inspectTailscaleServeRoot(port, found.tailscale.dnsName, undefined, 8_000);
}

async function chooseMachineConnection({ found, current, tailscalePlanned, requestedMode, args }) {
    const requestedPort = value(args, '--port');
    const plannedPort = requestedPort === undefined ? current?.relayPort || 8792 : Number(requestedPort);
    const serveRoot = serveRootFor(found, plannedPort);
    let mode = requestedMode;
    if (mode === 'selfhost') mode = undefined;
    if (!mode) {
        heading('Connect your phone to this computer');
        const proposal = recommendedConnection(found, current, tailscalePlanned, serveRoot);
        if (proposal) {
            status('Recommended route', proposal.title, 'ok');
            note(proposal.description);
            const action = await select('Continue with this route?', [
                { value: 'use', title: 'Use this route and continue', description: 'review every change before muxr applies it' },
                { value: 'advanced', title: 'Choose another way', description: 'private networks, same Wi-Fi, tunnels, and your own server' },
            ]);
            if (aborted(action)) return undefined;
            if (action === 'use') mode = proposal.mode;
        } else {
            note(['No ready route was detected.', 'Choose an existing network or server; muxr will not expose this computer automatically.']);
        }
        if (!mode) {
            const connectionChoices = choices(found, tailscalePlanned, serveRoot).map((choice) => choice.value === current?.connectionMode
                ? { ...choice, title: `${choice.title} · current` }
                : choice);
            const initial = Math.max(0, connectionChoices.findIndex((choice) => choice.value === current?.connectionMode));
            mode = await select('Choose another way', connectionChoices, initial);
        }
    }
    if (aborted(mode)) return undefined;
    if (!['tailscale', 'tailscale-direct', 'private', 'lan', 'external', 'cloudflare'].includes(mode)) {
        process.stderr.write(`unknown setup mode: ${mode}\n`);
        return 1;
    }
    if ((mode === 'tailscale' || mode === 'tailscale-direct') && !found.tailscale.connected && !tailscalePlanned) {
        process.stderr.write(`Tailscale is unavailable: ${found.tailscale.detail}; or pick a different relay\n`);
        return 1;
    }
    if (mode === 'private' && !found.private) {
        process.stderr.write('no private-network address was found; connect NetBird, WireGuard, or another private network, then retry\n');
        return 1;
    }
    if (mode === 'lan' && !found.lan) {
        process.stderr.write('no local network address was found; pick a different relay\n');
        return 1;
    }
    if (mode === 'cloudflare' && !found.cloudflared.ok) {
        process.stderr.write(`cloudflared is unavailable: ${found.cloudflared.detail}; pick a different relay\n`);
        return 1;
    }

    const port = plannedPort;
    if (!Number.isInteger(port) || port < 1024 || port > 65535) {
        process.stderr.write('setup port must be an integer from 1024 to 65535\n');
        return 1;
    }
    let endpoint = mode === 'private' && current?.connectionMode === 'private' && current.publicHealthy ? current.relayUrl : undefined;
    if (mode === 'external') {
        while (endpoint === undefined) {
            setupStep(2, 5, 'Enter your server address');
            const entered = await prompt('External relay URL (wss://...)', current?.connectionMode === 'external' ? current.relayUrl : '');
            if (entered === undefined) return undefined;
            try {
                const parsed = new URL(entered);
                if (parsed.protocol === 'wss:' && parsed.hostname && !parsed.username && !parsed.password && parsed.pathname === '/' && !parsed.search && !parsed.hash) endpoint = parsed.toString().replace(/\/$/, '');
                else status('External relay URL', 'use a root wss://host URL without credentials, query, or fragment', 'warn');
            } catch {
                status('External relay URL', 'use a valid wss:// URL', 'warn');
            }
        }
    }

    setupStep(2, 5, 'Choose app access');
    let web = false;
    if (modeAllowsBrowserHosting(mode)) {
        web = await select('Host the browser client too?', [
            { value: false, title: 'Native app only', description: 'do not expose the browser client' },
            { value: true, title: 'Host the browser client', description: 'serve it over the selected HTTPS/WSS connection' },
        ], current?.webEnabled ? 1 : 0);
        if (aborted(web)) return undefined;
    } else {
        status('Browser client', 'requires Tailscale Serve, External WSS, or Cloudflare; native app only', 'off');
    }
    const desiredUrl = advertisedUrlForMode({ mode, found, current, port, endpoint, web, tailscalePlanned });
    const connectionChanged = current === undefined || desiredUrl === undefined || current.relayUrl !== desiredUrl;
    const pairingChoices = [
        ...(current !== undefined ? [{
            value: 'none',
            title: 'Keep paired devices',
            description: connectionChanged
                ? 'same-LAN devices can adopt it through local discovery; remote devices must pair once with the new endpoint'
                : 'no new QR; existing devices keep working',
        }] : []),
        { value: 'phone', title: 'Phone', description: 'pair the native app first' },
        ...(web ? [
            { value: 'browser', title: 'Control browser', description: 'full terminal and agent control for eight hours' },
            { value: 'browser-view', title: 'View-only browser', description: 'observe agents without control for eight hours' },
            { value: 'both', title: 'Phone, then control browser', description: 'complete both pairing steps' },
        ] : []),
    ];
    setupStep(2, 5, 'Choose what to pair');
    const pairing = pairingChoices.length === 1 ? pairingChoices[0].value : await select(connectionChanged && current !== undefined
        ? 'The connection changed. Keep existing devices or pair another one?'
        : 'Pair a client?', pairingChoices);
    if (aborted(pairing)) return undefined;
    return { mode, port, endpoint, web, pairing };
}

async function recoverTailscaleServe({ plan, found }) {
    if (plan.mode !== 'tailscale') return plan;
    const serveRoot = serveRootFor(found, plan.port);
    if (serveRoot.status === 'free' || serveRoot.status === 'ours' || serveRoot.status === 'inconclusive') return plan;
    const occupied = serveRoot.status === 'occupied';
    const title = occupied ? 'Tailscale Serve is already in use' : 'Tailscale Serve is unavailable';
    setupStep(5, 5, title);
    heading(title);
    note(occupied ? [
        'Another service already owns the Tailscale Serve root.',
        'muxr left that service unchanged.',
        'You can use direct Tailscale networking now, or stop and rerun setup with another route.',
    ] : [
        serveRoot.reason || 'muxr could not verify that Tailscale Serve is available.',
        'muxr made no Serve changes.',
        'You can use direct Tailscale networking now, or stop and rerun setup with another route.',
    ]);
    const action = await select('How do you want to continue?', [
        { value: 'direct', title: 'Use direct Tailscale networking', description: 'reach this computer over its tailnet address · does not require Serve' },
        { value: 'stop', title: 'Stop here', description: 'keep completed prerequisites and rerun setup to choose another route' },
    ]);
    if (action !== 'direct') return undefined;
    const next = continueWithDirectTailscale(plan);
    if (plan.web) status('Browser client', 'needs Tailscale Serve or HTTPS; continuing with the native app only', 'warn');
    status('Connection', connectionLabel(next.mode, next.endpoint, next.port), 'ok');
    return next;
}

// Any abort before Apply must say so; a silent exit reads as "something ran".
function cancelled() {
    outro('Cancelled. Nothing changed.');
    completeFullscreen();
    return 0;
}

function stoppedAfterApply() {
    outro('Stopped before the relay was configured. Completed prerequisites were kept; rerun muxr to finish setup.', 'warn');
    completeFullscreen();
    return 1;
}

// Choosing this only adds Tailscale to the reviewed plan. The command itself
// stays behind Apply so every preflight and cancellation remains mutation-free.
async function offerTailscaleConnect(found) {
    if (found.tailscale.connected || !found.tailscale.installed) return false;
    const attempt = await select(`Tailscale is installed but not connected (${found.tailscale.detail}). Make it available during setup?`, [
        { value: false, title: 'Not now', description: 'continue without Tailscale' },
        { value: true, title: 'Connect during Apply', description: process.platform === 'darwin' ? 'open the Mac app after you approve the plan' : 'run sudo tailscale up after you approve the plan' },
    ]);
    return aborted(attempt) ? BACK : attempt === true;
}

async function applyTailscaleConnect(found) {
    let up;
    if (process.platform === 'darwin') {
        up = spawnSync('open', ['-a', 'Tailscale'], { stdio: 'inherit', timeout: 15_000 });
        if (up.status === 0 && await prompt('Approve the Tailscale system extension and sign in, then press Enter') === undefined) return false;
    } else {
        // USER can be unset (sudo, cron, containers); an empty --operator makes
        // the offered remedy fail with a usage error.
        let operator = process.env.USER?.trim();
        if (!operator) {
            try { operator = userInfo().username; } catch { operator = undefined; }
        }
        up = spawnSync('sudo', [tailscaleBin() || 'tailscale', 'up', ...(operator ? [`--operator=${operator}`] : [])], { stdio: 'inherit', timeout: 300_000 });
    }
    found.tailscale = probeTailscale();
    if (found.tailscale.connected) status('Tailscale', `connected — ${found.tailscale.ip}`, 'ok');
    else status('Tailscale', `${found.tailscale.detail ?? 'still not connected'}${up.status ? ` (connect command exited ${up.status})` : ''}`, 'warn');
    return found.tailscale.connected;
}

export async function applyMachineSetup(args = []) {
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
        const found = await withSpinner('Inspecting Herdr, agents, and networking', async () => probeMachine());
        renderInspection(found);
        outro('Inspection complete. Nothing changed.');
        return 0;
    }
    if (scripted) {
        const prerequisites = await runLocalPrerequisites(args);
        if (prerequisites !== 0) return prerequisites;
        return startSelfHost(args);
    }

    return withFullscreen(async () => {
    setupStep(1, 5, 'Check this machine');
    const found = await withSpinner('Inspecting Herdr, agents, and networking', async () => probeMachine());
    renderInspection(found);
    // A disconnected Tailscale installation is proposed as one reviewed route;
    // connecting it remains behind Apply instead of becoming a preflight prompt.
    const tailscalePlanned = found.tailscale.installed && !found.tailscale.connected && found.tailscale.backend !== undefined;
    const cancelSetup = () => cancelled();
    const current = await selfhostPublicSummary();

    setupStep(2, 5, 'Connect your phone');
    let plan = await chooseMachineConnection({ found, current, tailscalePlanned, requestedMode, args });
    if (plan === undefined) return cancelSetup();
    if (plan === 1) return 1;
    const desiredUrl = advertisedUrlForMode({ ...plan, found, current, tailscalePlanned });
    const connectionChanged = current === undefined || desiredUrl === undefined || current.relayUrl !== desiredUrl;

    setupStep(3, 5, 'Connect agents and add-ons');
    const syncIntegrations = await select(found.agents.checked
        ? `Connect your coding agents (${found.agents.available.length} detected)?`
        : 'Agent availability could not be checked. Retry integration setup anyway?', [
        { value: true, title: 'Connect coding agents', description: 'install lifecycle detection so their status stays current' },
        { value: false, title: 'Leave integrations unchanged', description: 'do not change coding-agent lifecycle integrations' },
    ]);
    if (aborted(syncIntegrations)) return cancelSetup();

    const plugins = current === undefined ? [] : await choosePlugins();
    if (plugins === undefined) return cancelSetup();

    setupStep(4, 5, 'Review setup');
    note([
        `Connection: ${connectionLabel(plan.mode, plan.endpoint, plan.port)}`,
        `Herdr: ${found.herdr.installed ? 'adopt existing installation and ensure its server is running' : 'download, install, and start during setup'}`,
        'Bundled plugins: link the public muxr plugins into Herdr',
        `Agent integrations: ${syncIntegrations ? 'sync detected lifecycle providers; leave agent prompt files unchanged' : 'leave lifecycle integrations unchanged'}`,
        `Optional add-ons: ${plugins.length ? plugins.map((plugin) => plugin.title).join(', ') : 'none'}`,
        `Browser client: ${plan.web ? 'host the web app; browser keys stay WebCrypto-wrapped on this device' : 'off'}`,
        `Pairing: ${pairingChoiceLabel(plan.pairing)}${browserGrantNote(plan.pairing, { planned: true })}`,
        `Ingress: ${ingressPlan(plan.mode, tailscalePlanned)}`,
        'Services: register or restart the relay and host with systemd/launchd',
        `Existing connections: ${connectionChanged ? 'stored grants stay authoritative and adopt the advertised endpoint automatically' : 'keep working; restart only if a reviewed runtime setting changed'}`,
        'No change is made until you choose Apply setup.',
    ]);
    const apply = await select('Apply this setup?', [
        { value: false, title: 'Cancel', description: 'leave this machine unchanged' },
        { value: true, title: 'Apply setup', description: 'make the reviewed changes, verify health, then show the pairing QR' },
    ], 1);
    if (apply !== true) return cancelSetup();

    setupStep(5, 5, 'Install, start, and pair');
    if ((plan.mode === 'tailscale' || plan.mode === 'tailscale-direct') && tailscalePlanned && !(await applyTailscaleConnect(found))) {
        process.stderr.write('Tailscale did not connect; fix the reported issue, then rerun setup\n');
        return 1;
    }
    const prerequisiteArgs = [
        ...args.filter((arg) => arg !== '--from-plugin'),
        ...(found.herdr.installed ? [] : ['--install-herdr']),
        ...(syncIntegrations ? [] : ['--no-integrations']),
    ];
    const prerequisites = await runLocalPrerequisites(prerequisiteArgs);
    if (prerequisites !== 0) return prerequisites;
    const pluginResult = await installPlugins(plugins);
    status('Network', 'checking Tailscale Serve ownership and local relay port', 'off');
    let result = 1;
    for (;;) {
        const recovered = await recoverTailscaleServe({ plan, found });
        if (recovered === undefined) return stoppedAfterApply();
        plan = recovered;
        result = await startSelfHost(selfhostArgsFromSetupPlan({ ...plan, found }));
        if (result === 0) break;
        if (plan.mode !== 'tailscale' || serveRootFor(found, plan.port).status !== 'occupied') return result;
    }
    const { mode, endpoint, port, pairing } = plan;
    const browserPairFailed = pairing === 'both' && (await pairDevice(['--browser'])) !== 0;
    const doctor = await inspectSetup();
    if (doctor !== 0) return doctor;
    const summary = await selfhostPublicSummary();
    setupStep(5, 5, 'Setup complete');
    note([
        `Your host runs here. Phones reach it over ${relayKind(mode)}.${pairing === 'none' ? ' Pair with `muxr pair` when ready.' : ''}`,
        `Connection: ${connectionLabel(mode, endpoint, port)}`,
        'Relay location: this machine',
        `Relay URL: ${summary?.relayUrl ?? 'unavailable'}`,
        `Web URL: ${summary?.webUrl ?? 'off'}`,
        `Relay service: ${summary?.relayHealthy ? 'running' : 'check required'}`,
        `Host service: ${summary?.hostRunning ? 'running' : 'check required'}`,
        `Herdr: ${found.herdr.running ? 'running' : 'started during setup'}`,
        `Integrations: ${syncIntegrations ? 'selected providers synced' : 'unchanged'}`,
        `Pairing: ${pairingReceiptLabel(pairing, browserPairFailed)}${browserGrantNote(pairing, { failed: browserPairFailed })}`,
        `Plugins: bundled${pluginResult.installed.length ? ` + ${pluginResult.installed.map((plugin) => plugin.title).join(', ')}` : ''}`,
        ...(pluginResult.failed.length ? [
            `Add-ons needing attention: ${pluginResult.failed.map((plugin) => plugin.title).join(', ')}`,
            'Retry add-ons by rerunning `muxr setup`; core pairing remains active.',
        ] : []),
        'Configuration: ~/.muxr (owner-only)',
    ]);
    const partial = browserPairFailed || pluginResult.failed.length > 0;
    outro(partial
        ? 'Core setup is ready, but one or more optional steps need attention.'
        : pairing === 'none'
            ? 'Setup updated. Existing devices will reconnect automatically.'
            : 'Paired. Open muxr on your phone, or run `muxr` anytime to change these choices.', partial ? 'warn' : 'ok');
    completeFullscreen();
    return partial ? 1 : 0;
    });
}

export async function hostSharedRelay() {
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
        process.stderr.write('muxr shared-relay is interactive; run it in a terminal\n');
        return 1;
    }
    intro();
    const found = await withSpinner('Inspecting secure networking on this server', async () => probeMachine());
    renderInspection(found);
    const tailscaleResult = await offerTailscaleConnect(found);
    if (aborted(tailscaleResult)) return cancelled();
    const tailscalePlanned = tailscaleResult === true;
    const cancelRelaySetup = () => cancelled();
    const current = await selfhostPublicSummary();
    if (current !== undefined && current.relayRole !== 'shared') {
        process.stderr.write('This machine already runs an agent host. Use a dedicated VPS for a shared relay, or remove the existing setup first.\n');
        return 1;
    }
    heading('This machine becomes the relay');
    status('relay', 'agent hosts dial out to it — the only choice is how they reach it', 'ok');
    process.stdout.write('\n');
    let port;
    while (port === undefined) {
        const entered = await prompt('Relay port', String(current?.relayPort ?? 8792));
        if (entered === undefined) return cancelRelaySetup();
        const parsed = Number(entered);
        if (Number.isInteger(parsed) && parsed >= 1024 && parsed <= 65535) port = parsed;
        else status('Relay port', 'enter an integer from 1024 to 65535', 'warn');
    }
    const options = choices(found, tailscalePlanned, serveRootFor(found, port)).filter((choice) => ['tailscale', 'external'].includes(choice.value)).map((choice) => choice.value === current?.connectionMode
        ? { ...choice, title: `${choice.title} · current` }
        : choice);
    const initial = Math.max(0, options.findIndex((choice) => choice.value === current?.connectionMode));
    const mode = await select('How should machines reach this shared relay?', options, initial);
    if (aborted(mode)) return cancelRelaySetup();
    let endpoint;
    if (mode === 'external') {
        while (endpoint === undefined) {
            const entered = await prompt('Public relay URL (wss://...)', current?.connectionMode === 'external' ? current.relayUrl : '');
            if (entered === undefined) return cancelRelaySetup();
            try {
                const parsed = new URL(entered);
                if (parsed.protocol === 'wss:' && parsed.hostname && !parsed.username && !parsed.password
                    && parsed.pathname === '/' && !parsed.search && !parsed.hash) endpoint = parsed.origin;
                else status('Public relay URL', 'use a root wss://host URL without credentials, query, or fragment', 'warn');
            } catch { status('Public relay URL', 'use a valid wss:// URL', 'warn'); }
        }
    }
    const desiredUrl = advertisedUrlForMode({ mode, found, current, port, endpoint, web: false, tailscalePlanned });
    const endpointChanged = current !== undefined && (desiredUrl === undefined || desiredUrl !== current.relayUrl);
    if (endpointChanged && await sharedMachineCount() > 0) {
        process.stderr.write('Revoke the enrolled machines before changing the shared relay endpoint. Their credentials and devices pin the current URL.\n');
        return 1;
    }
    const web = await select('Host the browser client?', [
        { value: false, title: 'Relay only', description: 'route encrypted native-app traffic only' },
        { value: true, title: 'Relay + browser', description: 'serve control or view-only browser clients over the same HTTPS origin' },
    ], current?.webEnabled ? 1 : 0);
    if (aborted(web)) return cancelRelaySetup();
    heading('Review shared relay');
    note([
        `Public connection: ${connectionLabel(mode, endpoint, port)}`,
        `Browser client: ${web ? 'web app over HTTPS; control and view-only grants expire after eight hours' : 'off'}`,
        `Ingress: ${ingressPlan(mode, tailscalePlanned, { shared: true })}`,
        'Service: supervised relay-only systemd/launchd service with Linux boot persistence; no Herdr or agent host on this server',
        'Authority: owner state remains on this server; enrolled machines receive scoped credentials only',
        ...(endpointChanged ? ['Endpoint change: create fresh enrollments and pair every machine again'] : []),
        'No change is made until you choose Apply shared relay.',
    ]);
    const apply = await select('Apply this shared relay?', [
        { value: false, title: 'Cancel', description: 'leave this server unchanged' },
        { value: true, title: 'Apply shared relay', description: 'configure ingress, relay, web, and its service' },
    ], 1);
    if (apply !== true) return cancelRelaySetup();
    if (mode === 'tailscale' && tailscalePlanned && !(await applyTailscaleConnect(found))) {
        process.stderr.write('Tailscale did not connect; fix the reported issue, then rerun setup\n');
        return 1;
    }
    const relayArgs = ['--relay-only', '--managed-relay', '--reconfigure', '--port', String(port), '--connection-mode', mode];
    if (mode === 'external') relayArgs.push('--advertise', endpoint);
    if (web) relayArgs.push('--web', '--yes');
    const result = await startSelfHost(relayArgs);
    if (result !== 0) return result;
    const summary = await selfhostPublicSummary();
    if (!summary?.publicHealthy) {
        process.stderr.write(`The relay is running locally, but ${summary?.relayUrl ?? 'the public endpoint'} did not pass HTTPS health verification. Fix DNS/reverse-proxy access, then rerun muxr.\n`);
        return 1;
    }
    heading('Shared relay ready');
    note([
        'This server is now the relay. Agent hosts dial out to it; phones reach those hosts through it.',
        'Relay location: this server',
        `Relay URL: ${summary?.relayUrl ?? 'unavailable'}`,
        `Web URL: ${summary?.webUrl ?? 'off'}`,
        `Relay service: ${summary?.relayHealthy && summary?.hostRunning ? 'running' : 'check required'}`,
        'Owner state: ~/.muxr (owner-only; never copy it to agent machines)',
    ]);
    const enroll = await select('Create an enrollment for an agent machine?', [
        { value: false, title: 'Not now', description: 'return to the muxr menu' },
        { value: true, title: 'Create enrollment', description: 'show a five-minute, single-use enrollment string' },
    ]);
    // The relay is already applied and health-verified here; only the
    // enrollment is optional, so "nothing changed" would be a lie.
    if (enroll !== true) {
        outro('Shared relay is up. No enrollment was created.');
        return 0;
    }
    return enrollMachine();
}

function describeEnrollment(raw) {
    try {
        const parsed = new URL(raw.trim());
        const payload = JSON.parse(Buffer.from(parsed.searchParams.get('payload') ?? '', 'base64url').toString('utf8'));
        if (parsed.protocol !== 'muxr:' || parsed.hostname !== 'enroll' || payload.v !== 1 || !String(payload.relay).startsWith('wss://')
            || typeof payload.expires === 'number' && payload.expires <= Date.now()) throw new Error('invalid');
        return { relay: new URL(payload.relay).origin, web: typeof payload.web === 'string' ? new URL(payload.web).origin : undefined };
    } catch { throw new Error('paste the complete muxr://enroll string from the shared relay server'); }
}

export async function connectRemoteRelay() {
    intro();
    const raw = await prompt('Machine enrollment string (muxr://enroll?...)');
    if (raw === undefined || raw === '') return cancelled();
    let enrollment;
    try { enrollment = describeEnrollment(raw); }
    catch (cause) { process.stderr.write(`${cause.message}\n`); return 1; }
    const found = await withSpinner('Inspecting Herdr and coding agents', async () => probeMachine());
    renderInspection(found);
    const current = await selfhostPublicSummary();
    const syncIntegrations = await select('Sync detected coding-agent integrations?', [
        { value: true, title: 'Sync integrations', description: `${found.agents.available.length} lifecycle providers available` },
        { value: false, title: 'Leave unchanged', description: 'do not change coding-agent lifecycle integrations' },
    ]);
    if (aborted(syncIntegrations)) return cancelled();
    const pairingChoices = [
        { value: 'phone', title: 'Phone', description: 'pair the native app after the host connects' },
        ...(enrollment.web ? [
            { value: 'browser', title: 'Control browser', description: 'full terminal and agent control for eight hours' },
            { value: 'browser-view', title: 'View-only browser', description: 'observe agents without control for eight hours' },
            { value: 'both', title: 'Phone, then control browser', description: 'complete both pairing steps' },
        ] : []),
        { value: 'none', title: 'Not now', description: 'connect the host without pairing a client yet' },
    ];
    const pairing = await select('Which client should pair?', pairingChoices);
    if (aborted(pairing)) return cancelled();
    const plugins = [];
    heading('Review remote connection');
    note([
        'Relay location: shared remote server',
        `Relay URL: ${enrollment.relay}`,
        `Web URL: ${enrollment.web ?? 'off'}`,
        'Machine keys: generated locally; private keys never leave this machine',
        'Credential: scoped to this machine; relay-owner authority is never copied here',
        `Herdr: ${found.herdr.installed ? 'adopt and start existing installation' : 'download, install, and start during setup'}`,
        `Integrations: ${syncIntegrations ? 'sync detected providers' : 'leave unchanged'}`,
        `Plugins: ${plugins.length ? plugins.map((plugin) => plugin.title).join(', ') : 'bundled only'}`,
        `Pairing: ${pairing === 'none' ? 'not now' : pairingChoiceLabel(pairing)}`,
        ...(current === undefined ? [] : [`Existing setup: replace ${current.relayLocation} relay ${current.relayUrl ?? ''}; every existing device needs a fresh pairing`]),
        'No local or remote state changes until you choose Apply connection.',
    ]);
    const apply = await select('Apply this remote connection?', [
        { value: false, title: 'Cancel', description: 'leave this machine unchanged; enrollment remains usable until it expires' },
        { value: true, title: 'Apply connection', description: 'claim enrollment, configure Herdr and host, then pair' },
    ], 1);
    if (apply !== true) return cancelled();
    const prerequisites = await runLocalPrerequisites([
        ...(found.herdr.installed ? [] : ['--install-herdr']),
        ...(syncIntegrations ? [] : ['--no-integrations']),
    ]);
    if (prerequisites !== 0) return prerequisites;
    const pluginResult = await installPlugins(plugins);
    const connectArgs = ['--enrollment', raw, '--force',
        ...(pairing === 'none' ? ['--no-pair'] : []),
        ...(pairing === 'browser' ? ['--pair-browser'] : []),
        ...(pairing === 'browser-view' ? ['--pair-browser-view'] : []),
        ...(pairing === 'both' ? ['--pair-both'] : []),
    ];
    const connected = await connectEnrollment(connectArgs);
    if (connected !== 0) return connected;
    const summary = await selfhostPublicSummary();
    heading('Remote connection ready');
    note([
        'Your host runs here and dials out to the shared relay. Phones reach it through that relay.',
        'Relay location: shared remote server',
        `Relay URL: ${summary?.relayUrl ?? enrollment.relay}`,
        `Web URL: ${summary?.webUrl ?? 'off'}`,
        `Relay: ${summary?.relayHealthy ? 'reachable' : 'check required'}`,
        `Local host service: ${summary?.hostRunning ? 'running' : 'check required'}`,
        `Machine credential expires: ${summary?.credentialExpiresAt ? new Date(summary.credentialExpiresAt).toLocaleDateString() : 'unavailable'}`,
        `Pairing: ${pairing === 'none' ? 'not requested' : `${pairing} completed`}`,
        `Plugins: bundled${pluginResult.installed.length ? ` + ${pluginResult.installed.map((plugin) => plugin.title).join(', ')}` : ''}`,
        ...(pluginResult.failed.length ? [`Plugin install failed: ${pluginResult.failed.map((plugin) => plugin.title).join(', ')}`] : []),
        'Configuration: ~/.muxr (owner-only)',
    ]);
    outro('Ready. The local host connects outbound to the shared relay; Herdr must remain running on this machine.');
    return 0;
}

export async function manageMachines() {
    const action = await select('Shared relay machines', [
        { value: 'enroll', title: 'Create enrollment', description: 'show a five-minute, one-use string for an agent machine' },
        { value: 'list', title: 'List machines', description: 'show friendly names and credential expiry' },
        { value: 'revoke', title: 'Revoke a machine', description: 'disconnect its host and every paired device' },
        { value: 'cancel', title: 'Back', description: 'make no changes' },
    ]);
    if (aborted(action) || action === 'cancel') return cancelled();
    if (action === 'enroll') return enrollMachine();
    if (action === 'list') return listMachines();
    if ((await listMachines()) !== 0) return 1;
    const reference = await prompt('Machine list number or exact name');
    return reference ? revokeMachine([reference]) : cancelled();
}
