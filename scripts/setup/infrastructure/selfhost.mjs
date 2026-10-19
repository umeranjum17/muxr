import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isIP } from 'node:net';
import { networkInterfaces } from 'node:os';
import {
    inspectServe,
    serve,
    SERVE_OWNED_ERROR,
    tailscaleName,
    tailscaleState,
    unserve,
} from '@byokit/reach';
import { advertisedUrlForMode, localRelayBase, parseConnection, publicRelayUrl } from '../domain/dist/index.js';
import { relayEntry } from './paths.mjs';
import {
    atomicWrite,
    env,
    executable,
    flagValue,
    home,
    platform,
    run,
    stateDir,
} from './runtime.mjs';

export function tailscaleBin() {
    const configured = env('MUXR_TAILSCALE_BIN');
    if (configured) return configured;
    const onPath = executable('tailscale');
    if (onPath || platform() !== 'darwin') return onPath;
    return [
        join(home(), 'Applications', 'Tailscale.app', 'Contents', 'MacOS', 'Tailscale'),
        '/Applications/Tailscale.app/Contents/MacOS/Tailscale',
    ].find((candidate) => executable(candidate));
}

export function isTailnetIPv4(address) {
    if (typeof address !== 'string' || isIP(address) !== 4) return false;
    const [first, second] = address.split('.').map(Number);
    return first === 100 && second >= 64 && second <= 127;
}

/** `--configure-only` state: a tailnet bind, or loopback behind Tailscale Serve. Its relay belongs to the foreground `muxr up`. */
export const headlessState = (state) => isTailnetIPv4(state?.bindHost) || state?.tailscaleServe === true;

/** A tailnet-recorded state is final for now: no setup path may replace, restart or re-register it. */
export function refuseTailnetState(state) {
    if (!headlessState(state)) return;
    throw new Error(`this computer runs headless on Tailscale (${state.relayUrl}) under MUXR_MODE=selfhost muxr up; it is already set up, and changing its address or port is not supported yet`);
}

export const selfhostPath = () => join(stateDir(), 'selfhost.json');

export function readSelfhostState() {
    try {
        if (!existsSync(selfhostPath())) return undefined;
        const parsed = JSON.parse(readFileSync(selfhostPath(), 'utf8'));
        return parsed?.version === 1 ? parsed : undefined;
    } catch {
        // A truncated selfhost.json must not kill `muxr`/`muxr doctor` — the
        // command whose job is diagnosing a broken install.
        return undefined;
    }
}

/**
 * True when selfhost.json exists but does not parse. Corrupt is not "not
 * configured": setup must never mint a new machine identity over it (that
 * destroys every pairing), so callers distinguish the two.
 */
export function selfhostStateUnreadable() {
    if (!existsSync(selfhostPath())) return false;
    try {
        JSON.parse(readFileSync(selfhostPath(), 'utf8'));
        return false;
    } catch {
        return true;
    }
}

export function selfhostConfigured() { return readSelfhostState() !== undefined; }

export function selfhostControlBase(state) {
    const parsed = parseConnection(state);
    if (!parsed.ok) return localRelayBase(state?.relayPort, state?.bindHost);
    return parsed.value.controlBase(state?.relayLocation === 'remote' ? env('MUXR_REMOTE_CONTROL_BASE') : undefined);
}

export function selfhostCredential(state) {
    const parsed = parseConnection(state);
    if (parsed.ok) return parsed.value.credential();
    if (typeof state?.mintSecret === 'string') return state.mintSecret;
    return state?.machineCredential;
}

export async function selfhostRelayHealthy(state, timeoutMs = 2_000) {
    if (state === undefined) return false;
    return fetch(`${selfhostControlBase(state)}/health`, { signal: AbortSignal.timeout(timeoutMs) })
        .then((response) => response.ok).catch(() => false);
}

export async function advertisedRelayHealthy(state) {
    const relay = publicRelayUrl(state?.relayUrl);
    if (relay === undefined) return false;
    const base = relay.replace(/^ws:/, 'http:').replace(/^wss:/, 'https:');
    return fetch(`${base}/health`, { signal: AbortSignal.timeout(10_000) }).then((response) => response.ok).catch(() => false);
}

export function writeSelfhostState(state) {
    atomicWrite(selfhostPath(), `${JSON.stringify(state, null, 2)}\n`);
}

export { localRelayBase, SERVE_OWNED_ERROR };

/** The Tailscale options reach shares with the rest of setup: setup owns where the CLI lives (MUXR_TAILSCALE_BIN, the macOS app). */
export function reachTailscaleOptions() {
    const bin = tailscaleBin();
    return bin === undefined ? {} : { bin };
}

export const TAILSCALE_INSTALL_URL = 'https://tailscale.com/download';
export const TAILSCALE_UP_HINT = process.platform === 'darwin' ? 'open Tailscale and sign in' : 'sudo tailscale up --operator=$USER';

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

export function classifyNetworkRoutes(interfaces = networkInterfaces(), ignoredAddress) {
    const routes = { private: undefined, lan: undefined };
    for (const [name, list] of Object.entries(interfaces)) {
        for (const entry of list ?? []) {
            if (entry.family !== 'IPv4' || entry.internal || entry.address === ignoredAddress || /^tailscale/i.test(name)) continue;
            // ponytail: CGNAT implies an overlay; add route-table evidence if WISP false positives become common.
            const overlay = /^(?:wt|netbird|nb|wg|zt|utun|tun|tap)/i.test(name) || overlayIpv4(entry.address);
            if (overlay && routes.private === undefined) routes.private = { address: entry.address, interface: name, provider: overlayProvider(name) };
            if (!overlay && routes.lan === undefined && privateIpv4(entry.address)
                && !/^(?:docker|br-|veth|virbr|podman|lxc|vbox|vmnet|hyperv|wsl)/i.test(name)) routes.lan = entry.address;
        }
    }
    return routes;
}

export async function probeTailscale() {
    const state = await tailscaleState(reachTailscaleOptions());
    if (!state.installed) return { installed: false, connected: false, detail: `not installed — ${TAILSCALE_INSTALL_URL}` };
    const ip = state.ips.find((candidate) => candidate.includes('.'));
    const backend = state.backendState;
    const connected = state.reason === undefined && backend === 'Running' && ip !== undefined;
    if (connected) return { installed: true, connected, ip, dnsName: state.dnsName, backend };
    const reason = backend !== undefined && backend !== 'Running'
        ? `backend state ${backend}` : state.reason ?? 'no tailnet address assigned yet';
    return { installed: true, connected: false, ip, dnsName: state.dnsName, backend, detail: `${reason} — try ${TAILSCALE_UP_HINT}` };
}

// One plain sentence: what is missing, how to fix it, and what to do next.
export function tailscaleMissing(tailscale, next) {
    if (!tailscale.installed) return `Tailscale isn't on this computer yet. Install it from ${TAILSCALE_INSTALL_URL} and sign in, then ${next}.`;
    return `Tailscale is on this computer but not connected: ${TAILSCALE_UP_HINT}, then ${next}.`;
}

/**
 * The route a computer with no setup screen takes (the desktop app): Tailscale
 * when it is up, else this Wi-Fi plus the sentence `muxr setup` shows for it.
 * Direct Tailscale, because Serve would change this computer's Tailscale config.
 */
export async function defaultRoute(port, next) {
    const tailscale = await probeTailscale();
    const found = { tailscale, lan: classifyNetworkRoutes(networkInterfaces(), tailscale.ip).lan };
    const advertise = (mode) => advertisedUrlForMode({ mode, found, port, web: false, tailscalePlanned: false });
    if (tailscale.connected) return { mode: 'tailscale-direct', relayUrl: advertise('tailscale-direct') };
    return {
        mode: 'lan',
        relayUrl: advertise('lan') ?? `ws://127.0.0.1:${port}`,
        hint: tailscaleMissing(tailscale, next),
        // gone: the probe clearly reports Tailscale missing or signed out; any
        // other no result may be the daemon lagging, not a route change.
        gone: !tailscale.installed || tailscale.backend === 'NeedsLogin',
    };
}

export async function tailscaleIngress(args) {
    if (args.includes('--tunnel') || flagValue(args, '--advertise') || args.includes('--tailscale-direct')) return undefined;
    const dnsName = await tailscaleName(reachTailscaleOptions());
    return dnsName === undefined ? undefined : { dnsName };
}

export async function inspectTailscaleServeRoot(port, dnsName, expectedProxy, timeout = 15_000) {
    return inspectServe(port, dnsName, {
        proxy: expectedProxy ?? `http://127.0.0.1:${port}`,
        timeoutMs: timeout,
        ...reachTailscaleOptions(),
    });
}

export function persistOwnedServeIngress(state, ingress) {
    if (ingress?.kind !== 'tailscale-serve') return state;
    const next = { ...state, ingress };
    writeSelfhostState(next);
    return next;
}

export function cloudflaredAlive(ingress) {
    if (ingress?.kind !== 'cloudflare-quick') return false;
    const pid = Number(ingress.pid);
    const command = Number.isSafeInteger(pid) && pid > 1 ? run(env('MUXR_PS_BIN') || 'ps', ['-ww', '-p', String(pid), '-o', 'command=']) : { ok: false };
    return command.ok && command.stdout.includes(`cloudflared tunnel --url http://127.0.0.1:${ingress.port}`);
}

export async function cleanupManagedIngress(state) {
    const ingress = state?.ingress;
    if (ingress?.kind === 'cloudflare-quick') {
        if (cloudflaredAlive(ingress)) process.kill(Number(ingress.pid), 'SIGTERM');
        return;
    }
    if (ingress?.kind !== 'tailscale-serve') return;
    const expected = typeof ingress.proxy === 'string' ? ingress.proxy : `http://127.0.0.1:${ingress.port}`;
    const ownership = await inspectTailscaleServeRoot(ingress.port, ingress.dnsName, expected);
    if (ownership.missing || ownership.status === 'free' || ownership.status === 'occupied') return;
    if (ownership.status === 'disabled' || ownership.status === 'inconclusive') {
        throw new Error('cannot inspect the previous muxr Tailscale Serve route; leaving it unchanged');
    }
    await unserve(ingress, reachTailscaleOptions());
}

export function ownedRelayPid() {
    const pidPath = join(stateDir(), 'relay', 'relay.pid');
    const pid = Number(existsSync(pidPath) ? readFileSync(pidPath, 'utf8').trim() : '');
    if (!Number.isSafeInteger(pid) || pid <= 1) return undefined;
    const command = run(env('MUXR_PS_BIN') || 'ps', ['-ww', '-p', String(pid), '-o', 'command=']);
    const relayCommand = command.ok ? command.stdout.trim() : '';
    return /(?:^|\s)\S*\/relay\.js(?:\s|$)/.test(relayCommand) || relayCommand.includes(relayEntry()) ? pid : undefined;
}

export async function stopOwnedSelfhostRelay() {
    const state = readSelfhostState();
    if (state === undefined || state.relayLocation === 'remote') return undefined;
    const port = Number(state.relayPort);
    const base = selfhostControlBase(state);
    const health = await fetch(`${base}/health`, { signal: AbortSignal.timeout(2_000) }).then((response) => {
        if (!response.ok) return undefined;
        return response.json();
    }).catch(() => undefined);
    if (health?.ok !== true) return undefined;
    const pid = ownedRelayPid();
    if (pid === undefined) throw new Error('relay pid does not belong to a muxr relay process; leaving it untouched');
    try { process.kill(pid, 'SIGTERM'); }
    catch (cause) {
        if (cause?.code === 'ESRCH') return { state, health, port };
        throw cause;
    }
    for (let attempt = 0; attempt < 30; attempt += 1) {
        const stopped = await fetch(`${base}/health`, { signal: AbortSignal.timeout(500) })
            .then(() => false)
            .catch((cause) => cause?.name !== 'TimeoutError');
        if (stopped) return { state, health, port };
        await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error('relay did not stop; leaving the existing process in place');
}
