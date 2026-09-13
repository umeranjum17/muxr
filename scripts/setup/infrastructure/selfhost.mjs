import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseConnection, publicRelayUrl } from '../domain/dist/index.js';
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

export function runTailscale(args, options = {}) {
    const { env: childEnv, timeout = 15_000, ...rest } = options;
    return spawnSync(tailscaleBin() || 'tailscale', args, {
        ...rest,
        timeout,
        env: { ...process.env, TAILSCALE_BE_CLI: '1', ...childEnv },
    });
}

export const selfhostPath = () => join(stateDir(), 'selfhost.json');

/** Raw parse of selfhost.json — a v1 (flat) or v2 (desired + runtime) record, or undefined. */
export function readSelfhostFile() {
    try {
        if (!existsSync(selfhostPath())) return undefined;
        const parsed = JSON.parse(readFileSync(selfhostPath(), 'utf8'));
        return parsed?.version === 1 || parsed?.version === 2 ? parsed : undefined;
    } catch {
        return undefined;
    }
}

/** connectionMode values whose relayUrl the operator sets explicitly; the rest are derived. */
const EXPLICIT_RELAY_URL_MODES = ['external', 'private', 'lan'];

/**
 * Split a v1 flat record into v2: editable desired at the top, generated
 * identity and observed state under `runtime`. Identity, grants, ingress
 * ownership and device records move verbatim — no key is regenerated. An
 * explicit legacy bind choice is retained; a derived route's relayUrl becomes
 * desired null (its actual URL lives in runtime). Pure: never writes.
 */
export function migrateSelfhostToV2(v1) {
    const desired = {
        setupRole: v1.setupRole ?? (v1.relayLocation === 'remote' ? 'remote-host' : 'single-machine'),
        ...(v1.connectionMode !== undefined ? { connectionMode: v1.connectionMode } : {}),
        relayPort: Number.isInteger(v1.relayPort) ? v1.relayPort : 8792,
        bindHost: v1.bindHost === '127.0.0.1' || v1.bindHost === '0.0.0.0' ? v1.bindHost : 'auto',
        ...(typeof v1.webEnabled === 'boolean' ? { webEnabled: v1.webEnabled } : {}),
        relayUrl: EXPLICIT_RELAY_URL_MODES.includes(v1.connectionMode) ? (v1.relayUrl ?? null) : null,
        serviceMode: v1.serviceMode ?? 'managed',
        ...(v1.notifyEmail ? { notifyEmail: v1.notifyEmail } : {}),
        integrationsSync: v1.integrationsSync ?? 'auto',
        pairingDefault: v1.pairingDefault ?? 'browser',
        bundledPlugins: v1.bundledPlugins ?? {},
        extraPlugins: v1.extraPlugins ?? [],
        ...(v1.voiceProvider ? { voiceProvider: v1.voiceProvider } : {}),
    };
    const runtime = {
        ...(v1.machine ? { machine: v1.machine } : {}),
        ...(v1.machineCredential ? { machineCredential: v1.machineCredential } : {}),
        ...(v1.credentialExpiresAt ? { credentialExpiresAt: v1.credentialExpiresAt } : {}),
        ...(v1.mintSecret ? { mintSecret: v1.mintSecret } : {}),
        ...(v1.relayLocation ? { relayLocation: v1.relayLocation } : {}),
        ...(v1.ingress ? { ingress: v1.ingress } : {}),
        ...(v1.relayPort !== undefined ? { relayPort: v1.relayPort } : {}),
        ...(v1.relayUrl !== undefined ? { relayUrl: v1.relayUrl } : {}),
        ...(v1.bindHost !== undefined ? { bindHost: v1.bindHost } : {}),
        ...(typeof v1.webEnabled === 'boolean' ? { webEnabled: v1.webEnabled } : {}),
        ...(v1.webRoot ? { webRoot: v1.webRoot } : {}),
        ...(v1.webOrigin ? { webOrigin: v1.webOrigin } : {}),
        appliedConfig: { ...desired },
    };
    return { version: 2, ...desired, runtime };
}

/** The flat applied-effective view v1 callers expect: runtime (actual/identity) over desired. */
function appliedView(v2) {
    const { runtime = {}, ...desired } = v2;
    return { ...desired, ...runtime, version: 2 };
}

/**
 * The applied-effective state for operational callers (auth, control base,
 * status): identity and actual endpoint from runtime, editable values from the
 * top level. A v1 file is already this flat shape; a v2 file is flattened with
 * runtime winning. Editable desired is read with `readDesiredConfig`.
 */
export function readSelfhostState() {
    const file = readSelfhostFile();
    if (file === undefined) return undefined;
    return file.version === 2 ? appliedView(file) : file;
}

/** The editable desired configuration (public JSON names), migrating a v1 file's view. */
export function readDesiredConfig() {
    const file = readSelfhostFile();
    if (file === undefined) return undefined;
    const v2 = file.version === 2 ? file : migrateSelfhostToV2(file);
    const { runtime: _runtime, version: _version, ...desired } = v2;
    return desired;
}

/**
 * Merge generated/observed fields into `runtime` only, never touching desired.
 * Migrates a v1 file to v2 in place. This is the single path health/ingress/
 * auth writers use so an observation can never overwrite an editable value.
 */
export function mergeSelfhostRuntime(partial) {
    const file = readSelfhostFile();
    if (file === undefined) return;
    const v2 = file.version === 2 ? file : migrateSelfhostToV2(file);
    v2.runtime = { ...(v2.runtime ?? {}), ...partial };
    writeSelfhostState(v2);
}

/** Merge validated editable values into the desired top level, preserving runtime. */
export function writeDesiredConfig(partialDesired) {
    const file = readSelfhostFile();
    const v2 = file === undefined
        ? { version: 2, runtime: {} }
        : (file.version === 2 ? file : migrateSelfhostToV2(file));
    for (const [key, value] of Object.entries(partialDesired)) {
        if (value === undefined) delete v2[key];
        else v2[key] = value;
    }
    v2.version = 2;
    writeSelfhostState(v2);
    return v2;
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
    if (!parsed.ok) return `http://127.0.0.1:${state?.relayPort}`;
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

export function tailscaleDnsName(value) {
    if (typeof value !== 'string') return undefined;
    const name = value.replace(/\.$/, '').toLowerCase();
    if (name.length === 0 || name.length > 253) return undefined;
    return name.split('.').every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)) ? name : undefined;
}

export function tailscaleIngress(args) {
    if (args.includes('--tunnel') || flagValue(args, '--advertise') || args.includes('--tailscale-direct')) return undefined;
    const status = runTailscale(['status', '--json'], { encoding: 'utf8' });
    if (status.error?.code === 'ENOENT') return undefined;
    if (status.status !== 0) {
        // A spawn error (EACCES, timeout, …) gives status:null and no stderr stream.
        const detail = (status.stderr || status.error?.message || '').trim();
        throw new Error(`Tailscale is installed but unavailable: ${detail || 'sign in or use --advertise'}`);
    }
    try {
        const parsed = JSON.parse(status.stdout);
        const reportedName = parsed?.Self?.DNSName;
        const dnsName = tailscaleDnsName(reportedName);
        if (!dnsName) {
            if (typeof reportedName !== 'string' || reportedName === '') {
                throw new Error('Tailscale MagicDNS name is unavailable. Enable MagicDNS, then retry, or explicitly choose direct Tailscale under Advanced.');
            }
            throw new Error('Tailscale reported an invalid MagicDNS name, so muxr did not create a pairing code or guess another address. Open Tailscale, verify this computer’s DNS name, then retry or choose another connection under Advanced.');
        }
        return { dnsName };
    } catch (cause) {
        if (cause instanceof SyntaxError) throw new Error('Tailscale returned invalid status JSON');
        throw cause;
    }
}

export function tailscaleRootProxy(value, dnsName) {
    const web = value?.Web;
    if (web === null || typeof web !== 'object') return undefined;
    const exact = dnsName ? web[`${dnsName}:443`]?.Handlers?.['/']?.Proxy : undefined;
    if (typeof exact === 'string') return exact;
    if (dnsName) return undefined;
    const roots = Object.entries(web)
        .filter(([address]) => address.endsWith(':443'))
        .map(([, config]) => config?.Handlers?.['/']?.Proxy)
        .filter((proxy) => typeof proxy === 'string');
    return roots.length === 1 ? roots[0] : undefined;
}

export const SERVE_OWNED_ERROR = 'Tailscale Serve root is already owned by another service; use --tailscale-direct or remove it yourself';

export function tailscaleServeFailure(result) {
    const output = [result.stderr, result.stdout].map((value) => value?.trim()).filter(Boolean).join('\n').slice(0, 2_000);
    if (/serve is not enabled on your tailnet/i.test(output)) {
        const enableUrl = output.match(/https:\/\/login\.tailscale\.com\/[^\s<>"']+/)?.[0];
        return `Tailscale Serve is not enabled on your tailnet. ${enableUrl ? `Enable it at ${enableUrl}` : 'Enable it in the Tailscale admin console'}, then rerun \`muxr setup\`; or choose direct Tailscale or LAN.`;
    }
    if (result.error?.code === 'ETIMEDOUT') return `${output ? `${output}\n` : ''}Tailscale Serve did not finish before the timeout; restart Tailscale or choose direct Tailscale or LAN.`;
    return output || result.error?.message || 'Tailscale Serve command failed';
}

export function inspectTailscaleServeRoot(port, dnsName, expectedProxy, timeout = 15_000) {
    const expected = expectedProxy ?? `http://127.0.0.1:${port}`;
    const current = runTailscale(['serve', 'status', '--json'], { encoding: 'utf8', timeout });
    if (current.error?.code === 'ENOENT') return { status: 'inconclusive', missing: true, reason: 'tailscale not found' };
    if (current.status !== 0 || current.error) {
        const output = [current.stderr, current.stdout].filter(Boolean).join('\n');
        return {
            status: /serve is not enabled on your tailnet/i.test(output) ? 'disabled' : 'inconclusive',
            reason: tailscaleServeFailure(current),
        };
    }
    let rootProxy;
    try { rootProxy = tailscaleRootProxy(JSON.parse(current.stdout || '{}'), dnsName); }
    catch { return { status: 'inconclusive', reason: 'Tailscale Serve returned invalid status JSON' }; }
    if (rootProxy === undefined) return { status: 'free' };
    if (rootProxy === expected) return { status: 'ours' };
    return { status: 'occupied' };
}

export function persistOwnedServeIngress(state, ingress) {
    if (ingress?.kind !== 'tailscale-serve') return state;
    // Ingress ownership is generated state: it lives in runtime and never
    // rewrites a desired value. Callers keep the flat applied view.
    mergeSelfhostRuntime({ ingress });
    return { ...state, ingress };
}

export function cloudflaredAlive(ingress) {
    if (ingress?.kind !== 'cloudflare-quick') return false;
    const pid = Number(ingress.pid);
    const command = Number.isSafeInteger(pid) && pid > 1 ? run(env('MUXR_PS_BIN') || 'ps', ['-ww', '-p', String(pid), '-o', 'command=']) : { ok: false };
    return command.ok && command.stdout.includes(`cloudflared tunnel --url http://127.0.0.1:${ingress.port}`);
}

export function cleanupManagedIngress(state) {
    const ingress = state?.ingress;
    if (ingress?.kind === 'cloudflare-quick') {
        if (cloudflaredAlive(ingress)) process.kill(Number(ingress.pid), 'SIGTERM');
        return;
    }
    if (ingress?.kind !== 'tailscale-serve') return;
    const expected = typeof ingress.proxy === 'string' ? ingress.proxy : `http://127.0.0.1:${ingress.port}`;
    const ownership = inspectTailscaleServeRoot(ingress.port, ingress.dnsName, expected);
    if (ownership.missing || ownership.status === 'free' || ownership.status === 'occupied') return;
    if (ownership.status === 'disabled' || ownership.status === 'inconclusive') {
        throw new Error('cannot inspect the previous muxr Tailscale Serve route; leaving it unchanged');
    }
    const disabled = runTailscale(['serve', '--https=443', 'off'], { encoding: 'utf8' });
    if (disabled.status !== 0) throw new Error(`could not remove the previous muxr Tailscale Serve route: ${disabled.stderr.trim() || disabled.stdout.trim()}`);
}

export async function stopOwnedSelfhostRelay() {
    const state = readSelfhostState();
    if (state === undefined || state.relayLocation === 'remote') return undefined;
    const port = Number(state.relayPort);
    const health = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(2_000) }).then((response) => {
        if (!response.ok) return undefined;
        return response.json();
    }).catch(() => undefined);
    if (health?.ok !== true) return undefined;
    const pidPath = join(stateDir(), 'relay', 'relay.pid');
    const pid = Number(existsSync(pidPath) ? readFileSync(pidPath, 'utf8').trim() : '');
    if (!Number.isSafeInteger(pid) || pid <= 1) throw new Error('running relay has no valid pid file; leaving it untouched');
    const command = run(env('MUXR_PS_BIN') || 'ps', ['-ww', '-p', String(pid), '-o', 'command=']);
    const relayCommand = command.ok ? command.stdout.trim() : '';
    if (!/(?:^|\s)\S*\/relay\.js(?:\s|$)/.test(relayCommand) && !relayCommand.includes(relayEntry())) {
        throw new Error('relay pid does not belong to a muxr relay process; leaving it untouched');
    }
    try { process.kill(pid, 'SIGTERM'); }
    catch (cause) {
        if (cause?.code === 'ESRCH') return { state, health, port };
        throw cause;
    }
    for (let attempt = 0; attempt < 30; attempt += 1) {
        const stopped = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(500) })
            .then(() => false)
            .catch((cause) => cause?.name !== 'TimeoutError');
        if (stopped) return { state, health, port };
        await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error('relay did not stop; leaving the existing process in place');
}
