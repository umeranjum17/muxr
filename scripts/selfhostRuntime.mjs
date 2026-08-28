import { createHash, randomBytes } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import {
    chmodSync,
    existsSync,
    lstatSync,
    mkdirSync,
    openSync,
    readFileSync,
    realpathSync,
    rmSync,
    writeFileSync,
} from 'node:fs';
import { hostname } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import nacl from 'tweetnacl';
import {
    BROWSER_GRANT_TTL_MS,
    DURABLE_GRANT_EXPIRES_AT,
    api,
    askVisible,
    atomicWrite,
    base64,
    createDeviceGrant,
    deriveV2Key,
    env,
    ensurePrivateDir,
    error,
    executable,
    flagValue,
    hash,
    home,
    hostPlatform,
    lanAddress,
    machineIdentity,
    platform,
    newPairingCode,
    newV2ReplayTracker,
    openV2,
    pairingCodeHash,
    print,
    printTerminalQr,
    publicRelayUrl,
    run,
    sealPairingCodePayload,
    stateDir,
} from './setupRuntime.mjs';
import { daemonDefinition, daemonIsRunning, runDaemon, serviceCommand, startMuxrDaemon } from './muxrDaemon.mjs';


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
    const { env: childEnv, ...rest } = options;
    return spawnSync(tailscaleBin() || 'tailscale', args, {
        ...rest,
        env: { ...process.env, TAILSCALE_BE_CLI: '1', ...childEnv },
    });
}

export function enrollmentPayload(link) {
    try {
        const parsed = new URL(link.trim());
        if (parsed.protocol !== 'muxr:' || parsed.hostname !== 'enroll') throw new Error('scheme');
        const compact = parsed.searchParams.get('payload');
        const payload = compact === null ? undefined : JSON.parse(Buffer.from(compact, 'base64url').toString('utf8'));
        const relay = publicRelayUrl(payload?.relay);
        if (payload?.v !== 1 || typeof payload?.id !== 'string' || typeof payload?.claim !== 'string'
            || relay === undefined || !relay.startsWith('wss://') || typeof payload?.expires === 'number' && payload.expires <= Date.now()) throw new Error('shape');
        return { id: payload.id, claim: payload.claim, relay };
    } catch { throw new Error('enrollment must be the muxr://enroll string created on the relay server'); }
}

export async function sharedMachineCount() {
    const state = readSelfhostState();
    if (state?.relayRole !== 'shared' || typeof state.mintSecret !== 'string') return 0;
    const listed = await api(selfhostControlBase(state), '/v1/selfhost/machines', { headers: { authorization: `Bearer ${state.mintSecret}` } });
    if (!listed.response.ok || !Array.isArray(listed.body.machines)) throw new Error(listed.body.error || 'could not verify enrolled machines');
    return listed.body.machines.filter((machine) => machine.revoked !== true).length;
}

export async function runMachines(command = 'list', args = []) {
    try {
        const state = readSelfhostState();
        if (state?.relayLocation === 'remote' || typeof state?.mintSecret !== 'string') throw new Error('machine management runs on the shared relay server');
        if (!(await selfhostRelayHealthy(state))) throw new Error('shared relay service is not healthy; choose Restart muxr, then try again');
        const base = selfhostControlBase(state);
        const headers = { authorization: `Bearer ${state.mintSecret}` };
        if (command === 'enroll') {
            if (state.connectionMode === 'cloudflare' && !cloudflaredAlive(state.ingress)) throw new Error('the Cloudflare tunnel is not running; restore the shared relay before creating enrollment');
            if (!(await selfhostRelayHealthy(state))) throw new Error('the shared relay is not healthy; run `muxr doctor` first');
            const relayUrl = publicRelayUrl(state.relayUrl);
            if (relayUrl === undefined || !relayUrl.startsWith('wss://')) throw new Error('shared relay enrollment requires a public wss:// relay URL');
            const created = await api(base, '/v1/selfhost/enrollments', {
                method: 'POST', headers,
                body: JSON.stringify({ relay_url: relayUrl, ...(state.webEnabled ? { web_url: relayUrl.replace(/^wss/, 'https') } : {}) }),
            });
            if (!created.response.ok) throw new Error(created.body.error || 'could not create enrollment');
            const payload = Buffer.from(JSON.stringify({ v: 1, id: created.body.enrollment_id, claim: created.body.claim,
                relay: created.body.relay_url, expires: Date.now() + Number(created.body.expires_in ?? 300) * 1000,
                ...(typeof created.body.web_url === 'string' ? { web: created.body.web_url } : {}) })).toString('base64url');
            const link = `muxr://enroll?payload=${payload}`;
            print('');
            if (process.stdout.isTTY) await printTerminalQr(link);
            print('Machine enrollment string (single-use, expires in five minutes):');
            print(link);
            const path = join(stateDir(), 'enrollment-link.txt');
            writeFileSync(path, `${link}\n`, { mode: 0o600 });
            print(`  saved exact enrollment string to ${path}`);
            return 0;
        }
        const listed = await api(base, '/v1/selfhost/machines', { headers });
        if (!listed.response.ok || !Array.isArray(listed.body.machines)) throw new Error(listed.body.error || 'could not list enrolled machines');
        const machines = listed.body.machines;
        if (command === 'list') {
            if (machines.length === 0) print('No enrolled machines.');
            else machines.forEach((machine, index) => print(`  ${index + 1}. ${machine.name || 'agent machine'} — enrolled ${new Date(machine.createdAt).toLocaleDateString()} · ${machine.revoked ? 'revoked; select it again to retry cleanup' : machine.expired ? 'credential expired' : `credential expires ${new Date(machine.expiresAt).toLocaleDateString()}`}`));
            return 0;
        }
        if (command !== 'revoke') throw new Error('usage: muxr machines enroll | list | revoke <number|name>');
        const reference = args.join(' ').trim();
        const position = /^\d+$/.test(reference) ? Number(reference) - 1 : -1;
        const named = machines.filter((machine) => machine.name?.toLowerCase() === reference.toLowerCase());
        const target = position >= 0 ? machines[position] : named.length === 1 ? named[0] : undefined;
        if (target === undefined) throw new Error(named.length > 1 ? 'machine name is ambiguous; use its list number' : 'machine not found');
        const revoked = await api(base, `/v1/selfhost/machines/${encodeURIComponent(target.slug)}`, { method: 'DELETE', headers });
        if (!revoked.response.ok) throw new Error(revoked.body.error || 'machine revocation failed');
        print(`  ✓ revoked ${target.name || 'agent machine'} and disconnected its devices`);
        return 0;
    } catch (cause) {
        error(cause instanceof Error ? cause.message : String(cause));
        return 1;
    }
}

export async function runRemoteConnect(args = []) {
    try {
        if (args.includes('--resume')) return await resumeRemoteConnect(args);
        const raw = flagValue(args, '--enrollment') ?? args.find((arg) => !arg.startsWith('--'));
        if (!raw) throw new Error('paste the enrollment with `muxr connect --enrollment <muxr://enroll?...>`');
        const enrollment = enrollmentPayload(raw);
        const existing = readSelfhostState();
        if (existing !== undefined && !args.includes('--force')) throw new Error('this machine already has muxr state; rerun interactive `muxr` to review replacing it');
        ensurePrivateDir(stateDir());
        const reuseIdentity = existing?.relayLocation === 'remote' && publicRelayUrl(existing.relayUrl) === enrollment.relay;
        const identity = machineIdentity(reuseIdentity ? existing : undefined);
        const message = Buffer.from(`muxr-enroll-v1\n${enrollment.id}\n${enrollment.relay}\n${identity.crypto.signingPublicKey}`, 'utf8');
        const proof = Buffer.from(nacl.sign.detached(message, Buffer.from(identity.crypto.signingSecretKey, 'base64'))).toString('base64');
        const enrollmentBase = env('MUXR_REMOTE_CONTROL_BASE')?.replace(/\/$/, '') ?? enrollment.relay.replace(/^wss:/, 'https:');
        const claimed = await api(enrollmentBase, `/v1/selfhost/enrollments/${encodeURIComponent(enrollment.id)}/claim`, {
            method: 'POST',
            body: JSON.stringify({ claim: enrollment.claim, relay_url: enrollment.relay,
                signing_public_key: identity.crypto.signingPublicKey, proof, name: identity.name ?? hostname() }),
        });
        if (!claimed.response.ok) throw new Error(claimed.body.error || 'machine enrollment failed');
        const expectedSlug = `machine-${createHash('sha256').update('muxr-machine-v1\0').update(Buffer.from(identity.crypto.signingPublicKey, 'base64')).digest('hex').slice(0, 32)}`;
        if (claimed.body.machine_slug !== expectedSlug || typeof claimed.body.machine_credential !== 'string'
            || typeof claimed.body.credential_expires_at !== 'string' || Date.parse(claimed.body.credential_expires_at) <= Date.now()) {
            throw new Error('relay returned an invalid machine identity');
        }
        identity.id = expectedSlug;
        const state = {
            version: 1,
            relayLocation: 'remote',
            relayUrl: enrollment.relay,
            connectionMode: 'remote',
            machineCredential: claimed.body.machine_credential,
            credentialExpiresAt: claimed.body.credential_expires_at,
            webEnabled: typeof claimed.body.web_url === 'string',
            webOrigin: typeof claimed.body.web_url === 'string' ? claimed.body.web_url : undefined,
            machine: identity,
        };
        const pendingPath = join(stateDir(), 'selfhost.pending.json');
        writeFileSync(pendingPath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
        if (existing !== undefined) {
            writeFileSync(join(stateDir(), 'selfhost.previous.json'), `${JSON.stringify(existing, null, 2)}\n`, { mode: 0o600 });
            try {
                if (existing.relayLocation !== 'remote') cleanupManagedIngress(existing);
                if (daemonIsRunning() && (await runDaemon(['stop'])) !== 0) throw new Error('could not stop the existing muxr service');
                await stopOwnedSelfhostRelay();
            } catch (cause) {
                writeSelfhostState(state);
                rmSync(pendingPath, { force: true });
                try { await startMuxrDaemon('selfhost', args, true); } catch { /* doctor reports the remaining service issue */ }
                throw new Error(`enrollment completed and the scoped credential was saved, but replacing the previous runtime failed: ${cause instanceof Error ? cause.message : String(cause)}; run \`muxr doctor\``);
            }
        }
        writeSelfhostState(state);
        rmSync(pendingPath, { force: true });
        try { await startMuxrDaemon('selfhost', args, true); }
        catch (cause) {
            throw new Error(`enrollment completed and the scoped credential was saved, but the local service did not start: ${cause instanceof Error ? cause.message : String(cause)}; choose Restart muxr after fixing the reported service issue`);
        }
        for (let attempt = 0; attempt < 40 && !(await remoteHostOnline(state)); attempt += 1) {
            await new Promise((resolve) => setTimeout(resolve, 250));
        }
        if (!(await remoteHostOnline(state))) throw new Error('the scoped credential was saved, but the local host did not authenticate with the shared relay; run `muxr doctor`');
        rmSync(join(stateDir(), 'selfhost.previous.json'), { force: true });
        print(`  ✓ connected this machine to ${enrollment.relay}`);
        print(`  ✓ machine credential expires ${new Date(state.credentialExpiresAt).toLocaleDateString()}`);
        if (args.includes('--no-pair')) return 0;
        const kind = args.includes('--pair-browser') || args.includes('--pair-browser-view') ? 'browser' : 'native';
        const authority = args.includes('--pair-browser-view') ? 'observe' : 'control';
        if ((kind === 'browser' || args.includes('--pair-both')) && !state.webEnabled) throw new Error('this shared relay does not host the browser client; pair the native app instead');
        const paired = await withSelfhostRotationLock(() => runSelfhostPair(state, kind, authority));
        if (paired !== 0) return paired;
        return args.includes('--pair-both') ? runPair(['--browser']) : 0;
    } catch (cause) {
        error(cause instanceof Error ? cause.message : String(cause));
        return 1;
    }
}

export const selfhostPath = () => join(stateDir(), 'selfhost.json');
export const relayEntry = () => existsSync(fileURLToPath(new URL('./relay.js', import.meta.url)))
    ? fileURLToPath(new URL('./relay.js', import.meta.url))
    : fileURLToPath(new URL('../apps/relay/dist/main.js', import.meta.url));

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

/** Enable the bundled web client without reopening unrelated setup choices. */
export async function enableBrowserHosting() {
    const state = readSelfhostState();
    if (state === undefined) return 1;
    if (state.webEnabled === true && publicRelayUrl(state.relayUrl)?.startsWith('wss://') === true) return 0;
    if (state.relayLocation === 'remote') {
        error('Browser hosting must be enabled by the shared-relay owner, then this computer must reconnect with a fresh enrollment.');
        return 1;
    }
    if (state.connectionMode === 'cloudflare') {
        error('The current quick Cloudflare URL is temporary. Change setup to Tailscale Serve or your own stable WSS endpoint before enabling browser access.');
        return 1;
    }
    if (!publicRelayUrl(state.relayUrl)?.startsWith('wss://')) {
        error('Browser access needs a secure HTTPS connection. Change this setup to Tailscale Serve or your own WSS endpoint first.');
        return 1;
    }
    print('Enabling browser access on the current secure connection…');
    const args = [
        '--reconfigure', '--web', '--yes', '--no-pair',
        '--port', String(state.relayPort),
    ];
    if (typeof state.connectionMode === 'string') args.push('--connection-mode', state.connectionMode);
    if (state.connectionMode === 'external' || state.connectionMode === 'cloudflare') args.push('--advertise', state.relayUrl);
    return runSelfHost(args);
}

export function browserHostingCanEnable() {
    const state = readSelfhostState();
    return state?.relayLocation !== 'remote' && state?.connectionMode !== 'cloudflare'
        && publicRelayUrl(state?.relayUrl)?.startsWith('wss://') === true;
}

/** Menu-only summary used by cli.mjs to guide browser pairing. */
export function browserHostingReady() {
    const state = readSelfhostState();
    return state !== undefined && state.webEnabled === true && publicRelayUrl(state.relayUrl)?.startsWith('wss://') === true;
}

export function selfhostConfigured() { return readSelfhostState() !== undefined; }

export function selfhostControlBase(state) {
    const relay = publicRelayUrl(state?.relayUrl);
    const remoteOverride = state?.relayLocation === 'remote' && env('MUXR_REMOTE_CONTROL_BASE');
    if (remoteOverride) return env('MUXR_REMOTE_CONTROL_BASE').replace(/\/$/, '');
    if (state?.relayLocation === 'remote' && relay !== undefined) {
        return relay.replace(/^ws:/, 'http:').replace(/^wss:/, 'https:');
    }
    return `http://127.0.0.1:${state?.relayPort}`;
}

export function selfhostCredential(state) {
    return typeof state?.mintSecret === 'string' ? state.mintSecret : state?.machineCredential;
}

export async function selfhostRelayHealthy(state) {
    if (state === undefined) return false;
    return fetch(`${selfhostControlBase(state)}/health`).then((response) => response.ok).catch(() => false);
}

export async function advertisedRelayHealthy(state) {
    const relay = publicRelayUrl(state?.relayUrl);
    if (relay === undefined) return false;
    const base = relay.replace(/^ws:/, 'http:').replace(/^wss:/, 'https:');
    return fetch(`${base}/health`, { signal: AbortSignal.timeout(10_000) }).then((response) => response.ok).catch(() => false);
}

export async function remoteHostOnline(state) {
    if (state?.relayLocation !== 'remote' || env('MUXR_REMOTE_HOST_ONLINE') === '1') return true;
    const result = await api(selfhostControlBase(state), '/v1/selfhost/machine-status', {
        headers: { authorization: `Bearer ${selfhostCredential(state)}` },
    }).catch(() => undefined);
    return result?.response.ok === true && result.body.online === true;
}

export async function selfhostPublicSummary() {
    const state = readSelfhostState();
    if (state === undefined) return undefined;
    const relayHealthy = await selfhostRelayHealthy(state);
    const publicHealthy = await advertisedRelayHealthy(state);
    return {
        connectionMode: typeof state.connectionMode === 'string' ? state.connectionMode : undefined,
        relayLocation: state.relayLocation === 'remote' ? 'remote' : 'local',
        relayRole: state.relayRole === 'shared' ? 'shared' : state.relayRole === 'single-machine' ? 'single-machine' : undefined,
        relayPort: Number.isInteger(state.relayPort) ? state.relayPort : undefined,
        relayUrl: publicRelayUrl(state.relayUrl),
        webEnabled: state.webEnabled === true,
        ingressHealthy: state.connectionMode !== 'cloudflare' || cloudflaredAlive(state.ingress),
        webUrl: state.webEnabled === true ? publicRelayUrl(state.relayUrl)?.replace(/^ws/, 'http') : undefined,
        relayHealthy,
        publicHealthy,
        hostRunning: daemonIsRunning(),
        credentialExpiresAt: typeof state.credentialExpiresAt === 'string' ? state.credentialExpiresAt : undefined,
    };
}

export function writeSelfhostState(state) {
    atomicWrite(selfhostPath(), `${JSON.stringify(state, null, 2)}\n`);
}

export function pendingRemotePath() { return join(stateDir(), 'selfhost.pending.json'); }

export function hasPendingRemoteConnect() { return existsSync(pendingRemotePath()); }

export async function resumeRemoteConnect(args = []) {
    if (!hasPendingRemoteConnect()) throw new Error('no interrupted remote enrollment is waiting to resume');
    const pending = JSON.parse(readFileSync(pendingRemotePath(), 'utf8'));
    if (pending?.version !== 1 || pending.relayLocation !== 'remote' || typeof pending.machineCredential !== 'string'
        || typeof pending.credentialExpiresAt !== 'string' || Date.parse(pending.credentialExpiresAt) <= Date.now()) {
        throw new Error('pending remote enrollment is invalid or expired; create a fresh enrollment on the relay server');
    }
    const check = await api(selfhostControlBase(pending), '/v1/selfhost/machine-status', {
        headers: { authorization: `Bearer ${pending.machineCredential}` },
    }).catch(() => { throw new Error('could not reach the shared relay; check the network and try Resume again'); });
    if (!check.response.ok) throw new Error(check.body.error || 'pending machine credential was rejected');
    const current = readSelfhostState();
    if (current !== undefined) writeFileSync(join(stateDir(), 'selfhost.previous.json'), `${JSON.stringify(current, null, 2)}\n`, { mode: 0o600 });
    writeSelfhostState(pending);
    rmSync(pendingRemotePath(), { force: true });
    await startMuxrDaemon('selfhost', args, true);
    for (let attempt = 0; attempt < 40 && !(await remoteHostOnline(pending)); attempt += 1) await new Promise((resolve) => setTimeout(resolve, 250));
    if (!(await remoteHostOnline(pending))) throw new Error('remote enrollment was restored, but the host did not authenticate; run `muxr doctor`');
    rmSync(join(stateDir(), 'selfhost.previous.json'), { force: true });
    print('  ✓ resumed the remote relay connection');
    return 0;
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
        // A spawn error (EACCES, …) gives status:null and no stderr stream.
        const detail = (status.stderr ?? status.error?.message ?? '').trim();
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
    const current = runTailscale(['serve', 'status', '--json'], { encoding: 'utf8' });
    if (current.error?.code === 'ENOENT') return;
    if (current.status !== 0) throw new Error('cannot inspect the previous muxr Tailscale Serve route; leaving it unchanged');
    let parsed;
    try { parsed = JSON.parse(current.stdout || '{}'); }
    catch { throw new Error('Tailscale Serve returned invalid status JSON; leaving it unchanged'); }
    const expected = `http://127.0.0.1:${ingress.port}`;
    const rootProxy = tailscaleRootProxy(parsed, ingress.dnsName);
    if (rootProxy === undefined) return;
    if (rootProxy !== expected) throw new Error('the previous Tailscale Serve route changed outside muxr; leaving it unchanged');
    const disabled = runTailscale(['serve', '--https=443', 'off'], { encoding: 'utf8' });
    if (disabled.status !== 0) throw new Error(`could not remove the previous muxr Tailscale Serve route: ${disabled.stderr.trim() || disabled.stdout.trim()}`);
}

export async function resolveAdvertise(args, port, tailscale) {
    const explicit = flagValue(args, '--advertise')?.trim();
    if (explicit) {
        let parsed;
        try { parsed = new URL(explicit); }
        catch { throw new Error('--advertise must be a valid ws:// or wss:// URL'); }
        if (!['ws:', 'wss:'].includes(parsed.protocol) || !parsed.hostname || parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash) {
            throw new Error('--advertise must be a root ws:// or wss:// URL without credentials, paths, query, or fragment');
        }
        return { url: parsed.toString().replace(/\/$/, ''), note: 'explicit --advertise' };
    }
    if (args.includes('--tunnel')) {
        const check = spawnSync('cloudflared', ['--version'], { encoding: 'utf8' });
        if (check.error) throw new Error('cloudflared not found; install it or use --advertise=<url>');
        const logPath = join(stateDir(), 'logs', 'cloudflared.log');
        ensurePrivateDir(dirname(logPath));
        const out = openSync(logPath, 'w', 0o600);
        chmodSync(logPath, 0o600);
        const proc = spawn('cloudflared', ['tunnel', '--url', `http://127.0.0.1:${port}`], { detached: true, stdio: ['ignore', out, out] });
        proc.unref();
        let tunnelUrl;
        for (let i = 0; i < 50 && tunnelUrl === undefined; i++) {
            await new Promise((resolve) => setTimeout(resolve, 400));
            const match = readFileSync(logPath, 'utf8').match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
            if (match) tunnelUrl = match[0];
        }
        if (tunnelUrl === undefined) {
            proc.kill('SIGTERM');
            throw new Error(`cloudflared did not print a tunnel URL; see ${logPath}`);
        }
        return {
            url: tunnelUrl.replace(/^https/, 'wss'),
            note: 'cloudflare quick tunnel (ephemeral URL; use a named tunnel for permanence)',
            ingress: { kind: 'cloudflare-quick', pid: proc.pid, port },
        };
    }
    if (tailscale) {
        const current = runTailscale(['serve', 'status', '--json'], { encoding: 'utf8' });
        if (current.status !== 0) throw new Error(`cannot inspect Tailscale Serve ownership: ${current.stderr.trim() || 'status failed'}`);
        let rootProxy;
        try { rootProxy = tailscaleRootProxy(JSON.parse(current.stdout || '{}'), tailscale.dnsName); }
        catch { throw new Error('Tailscale Serve returned invalid status JSON'); }
        const expected = `http://127.0.0.1:${port}`;
        if (rootProxy !== undefined && rootProxy !== expected) throw new Error('Tailscale Serve root is already owned by another service; use --tailscale-direct or remove it yourself');
        const serve = rootProxy === expected
            ? { status: 0, stdout: '', stderr: '' }
            : runTailscale(['serve', '--yes', '--bg', '--https=443', expected], { encoding: 'utf8' });
        if (serve.status !== 0) throw new Error(`tailscale serve failed: ${serve.stderr.trim() || serve.stdout.trim() || 'check operator permissions'}; use --tailscale-direct for direct tailnet mode`);
        return {
            url: `wss://${tailscale.dnsName}`,
            note: 'Tailscale Serve (private tailnet HTTPS)',
            ingress: { kind: 'tailscale-serve', port, dnsName: tailscale.dnsName },
        };
    }
    const status = runTailscale(['status', '--json'], { encoding: 'utf8' });
    if (status.status === 0) {
        try {
            const ip = JSON.parse(status.stdout)?.Self?.TailscaleIPs?.find((value) => /^100\./.test(value));
            if (ip) return { url: `ws://${ip}:${port}`, note: 'direct Tailscale address' };
        } catch {}
    }
    const lan = lanAddress();
    if (lan !== undefined) return { url: `ws://${lan}:${port}`, note: 'LAN only — phone must be on this network; pair only on a network you trust' };
    throw new Error('no advertise address; use --advertise <url>');
}

export function relayDiscovery(state) {
    return state?.machine?.id && state?.relayUrl ? {
        machineId: state.machine.id,
        name: state.machine.name,
        relayUrl: state.relayUrl,
        mode: state.connectionMode,
    } : undefined;
}

export async function ensureSelfhostRelay(port, webRoot, host = '0.0.0.0', webOrigin, discovery) {
    const health = await fetch(`http://127.0.0.1:${port}/health`).then((r) => r.ok ? r.json() : undefined).catch(() => undefined);
    const healthy = health?.ok === true;
    const dataDir = join(stateDir(), 'relay');
    if (healthy) {
        // A ghost relay (old process, deleted dataDir) answers health but has no
        // mint secret on disk — refuse rather than failing mysteriously later.
        if (!existsSync(join(dataDir, 'mint-secret'))) {
            throw new Error(`port ${port} answers but is not this relay's state; stop the stale relay on :${port} first`);
        }
        if (health.webEnabled !== (webRoot !== undefined) || health.bindHost !== host) {
            throw new Error(`relay on :${port} is already running with different web/bind settings; stop it, then rerun setup`);
        }
        return;
    }
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    const logPath = join(stateDir(), 'logs', 'relay.log');
    ensurePrivateDir(dirname(logPath));
    const out = openSync(logPath, 'a', 0o600);
    chmodSync(logPath, 0o600);
    const proc = spawn(process.execPath, [relayEntry()], {
        detached: true,
        stdio: ['ignore', out, out],
        env: {
            ...process.env,
            MUXR_RELAY_LOCAL_AUTHORITY: '1',
            MUXR_RELAY_MDNS: discovery ? '1' : '0',
            ...(discovery?.machineId ? { MUXR_RELAY_MDNS_MACHINE: discovery.machineId } : {}),
            ...(discovery?.name ? { MUXR_RELAY_MDNS_NAME: `muxr ${discovery.name}` } : {}),
            ...(discovery?.relayUrl ? { MUXR_RELAY_MDNS_RELAY: discovery.relayUrl } : {}),
            ...(discovery?.mode ? { MUXR_RELAY_MDNS_MODE: discovery.mode } : {}),
            MUXR_RELAY_PORT: String(port),
            MUXR_RELAY_HOST: host,
            MUXR_RELAY_DATA_DIR: dataDir,
            ...(webRoot ? { MUXR_WEB_ROOT: webRoot } : {}),
            ...(webOrigin ? { MUXR_ALLOWED_ORIGINS: webOrigin } : {}),
        },
    });
    proc.unref();
    for (let i = 0; i < 25; i++) {
        await new Promise((resolve) => setTimeout(resolve, 400));
        if (await fetch(`http://127.0.0.1:${port}/health`).then((r) => r.ok).catch(() => false)) return;
    }
    throw new Error(`self-host relay did not come up on :${port}; see ${logPath}`);
}

export async function stopOwnedSelfhostRelay() {
    const state = readSelfhostState();
    if (state === undefined || state.relayLocation === 'remote') return undefined;
    const port = Number(state.relayPort);
    const health = await fetch(`http://127.0.0.1:${port}/health`).then((response) => response.ok ? response.json() : undefined).catch(() => undefined);
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
    catch (cause) { if (cause?.code === 'ESRCH') return { state, health, port }; else throw cause; }
    for (let attempt = 0; attempt < 30; attempt += 1) {
        const stopped = await fetch(`http://127.0.0.1:${port}/health`).then(() => false).catch(() => true);
        if (stopped) return { state, health, port };
        await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error('relay did not stop; leaving the existing process in place');
}

export function persistRelayRuntimeState({ state, health }) {
    state.bindHost = health.bindHost === '127.0.0.1' ? '127.0.0.1' : '0.0.0.0';
    state.webEnabled = health.webEnabled === true;
    state.webRoot = state.webEnabled ? join(dirname(realpathSync(process.argv[1])), 'web') : undefined;
    state.webOrigin = state.webEnabled && typeof state.relayUrl === 'string' ? state.relayUrl.replace(/^wss/, 'https') : undefined;
    writeSelfhostState(state);
}

export async function stopSelfhostRelayIfRunning() {
    const previous = await stopOwnedSelfhostRelay();
    if (previous === undefined) return false;
    persistRelayRuntimeState(previous);
    return true;
}

export async function restartSelfhostRelayIfRunning() {
    const previous = await stopOwnedSelfhostRelay();
    if (previous === undefined) return false;
    persistRelayRuntimeState(previous);
    const { state, port } = previous;
    await ensureSelfhostRelay(port, state.webRoot, state.bindHost, state.webOrigin, relayDiscovery(state));
    return true;
}

export async function runSelfHost(args = []) {
    let pendingIngress;
    const port = Number(flagValue(args, '--port') ?? 8792);
    const relayOnly = args.includes('--relay-only');
    const managedRelay = args.includes('--managed-relay');
    const hostOnly = args.includes('--host-only');
    const dryRun = args.includes('--dry-run');
    const web = args.includes('--web');
    const pairKind = args.includes('--pair-browser') || args.includes('--pair-browser-view') ? 'browser' : 'native';
    const pairAuthority = args.includes('--pair-browser-view') ? 'observe' : 'control';
    const noPair = args.includes('--no-pair');
    const connectionMode = flagValue(args, '--connection-mode');
    const reconfigure = args.includes('--reconfigure');
    if (web && !process.stdout.isTTY && !args.includes('--yes')) {
        error('--web requires an interactive trust confirmation or explicit --yes');
        return 1;
    }
    const webRoot = flagValue(args, '--web-root') ?? join(dirname(realpathSync(process.argv[1])), 'web');
    try {
        if (relayOnly && hostOnly) throw new Error('choose only one of --relay-only or --host-only');
        if (selfhostStateUnreadable()) {
            // Corrupt is not "not configured": reconfiguring would mint a new
            // machine identity and destroy every pairing.
            throw new Error(`${selfhostPath()} exists but is unreadable (truncated or corrupt); refusing to reconfigure over it. Move it aside when you are sure — \`mv ${selfhostPath()} ${selfhostPath()}.broken\` — then rerun`);
        }
        if (web && process.stdout.isTTY && !args.includes('--yes')) {
            print('Web access supports 8-hour control or view-only browser grants. Secret material is WebCrypto-wrapped in IndexedDB; close shared browsers and revoke them from `muxr devices`.');
            const approved = await askVisible('Continue with browser access? [y/N] ');
            if (!approved) return 0;
        }
        if (dryRun) {
            print(`  would start ${relayOnly ? 'the self-host relay' : hostOnly ? 'the self-host agent host' : 'the self-host relay and agent host'}`);
            if (!relayOnly) print('  would create a single-use encrypted mobile pairing QR');
            return 0;
        }
        let state = readSelfhostState();
        if (hostOnly) {
            if (state === undefined) throw new Error('no self-host state yet; run `muxr self-host` first');
            await startMuxrDaemon('selfhost', args);
            print('Ready — the muxr host is connected to your relay.');
            return 0;
        }
        if (state === undefined) {
            state = { version: 1, machine: machineIdentity(undefined), relayPort: port };
        }
        const hostWasRunning = daemonIsRunning();
        const explicitAdvertise = flagValue(args, '--advertise')?.replace(/\/$/, '');
        const sameConfiguration = state.relayPort === port
            && state.connectionMode === connectionMode
            && state.webEnabled === web
            && (connectionMode !== 'external' && connectionMode !== 'lan' || state.relayUrl === explicitAdvertise);
        if (!sameConfiguration && reconfigure) {
            cleanupManagedIngress(state);
            if (hostWasRunning && (await runDaemon(['stop'])) !== 0) throw new Error('could not stop the managed muxr service before reconfiguration');
            await stopOwnedSelfhostRelay();
            delete state.ingress;
        }
        state.relayPort = port;
        if (web && !existsSync(join(webRoot, 'index.html'))) throw new Error(`web client missing at ${webRoot}; install a package with the web client or pass --web-root`);
        // Missing Tailscale is fine. Broken/unsafe Tailscale status must fail
        // closed; another transport is chosen explicitly, never as a guess.
        const tailscale = tailscaleIngress(args);
        const advertise = sameConfiguration && connectionMode === 'cloudflare' && typeof state.relayUrl === 'string' && cloudflaredAlive(state.ingress)
            ? { url: state.relayUrl, note: 'existing Cloudflare quick tunnel', ingress: state.ingress }
            : await resolveAdvertise(args, port, tailscale);
        pendingIngress = advertise.ingress?.kind === 'cloudflare-quick' ? advertise.ingress : undefined;
        if (web && !advertise.url.startsWith('wss://')) throw new Error('--web requires HTTPS (Tailscale Serve, a named HTTPS tunnel, or --advertise wss://...)');
        const bindHost = tailscale || args.includes('--tunnel') || web || explicitAdvertise?.startsWith('wss://') ? '127.0.0.1' : '0.0.0.0';
        const webOrigin = web ? advertise.url.replace(/^wss/, 'https') : undefined;
        await ensureSelfhostRelay(port, web ? webRoot : undefined, bindHost, webOrigin, {
            machineId: state.machine.id,
            name: state.machine.name,
            relayUrl: advertise.url,
            mode: connectionMode,
        });
        const mintPath = join(stateDir(), 'relay', 'mint-secret');
        const mintInfo = lstatSync(mintPath);
        if (!mintInfo.isFile() || mintInfo.isSymbolicLink() || (mintInfo.mode & 0o077) !== 0) {
            throw new Error(`${mintPath} must be a regular owner-only file`);
        }
        const secretRaw = JSON.parse(readFileSync(mintPath, 'utf8'));
        state.mintSecret = secretRaw;
        state.relayUrl = advertise.url;
        state.relayLocation = 'local';
        delete state.machineCredential;
        delete state.credentialExpiresAt;
        state.relayRole = managedRelay ? 'shared' : 'single-machine';
        state.connectionMode = connectionMode;
        state.webEnabled = web;
        state.webRoot = web ? webRoot : undefined;
        state.webOrigin = webOrigin;
        state.bindHost = bindHost;
        state.ingress = advertise.ingress;
        writeSelfhostState(state);
        pendingIngress = undefined;
        print(`  ✓ self-host relay on :${port} (${advertise.note})`);
        print(`  ✓ advertise ${advertise.url}`);
        if (web) print(`  ✓ web client ${advertise.url.replace(/^ws/, 'http')}`);
        if (relayOnly) {
            if (managedRelay) {
                if (env('MUXR_NO_SERVICE_COMMANDS') !== '1') await stopOwnedSelfhostRelay();
                try { await startMuxrDaemon('relay', args, !sameConfiguration || !hostWasRunning); }
                catch (cause) {
                    await ensureSelfhostRelay(port, web ? webRoot : undefined, bindHost, webOrigin, relayDiscovery(state)).catch(() => undefined);
                    throw new Error(`the supervised relay service did not start; the temporary relay was restored when possible: ${cause instanceof Error ? cause.message : String(cause)}`);
                }
                delete state.machine;
                writeSelfhostState(state);
                print('Shared relay service ready. Create a machine enrollment from the muxr menu.');
            } else {
                print('Relay ready. Run `muxr self-host --host-only` on the machine holding this state.');
            }
            return 0;
        }
        if (env('MUXR_NO_SERVICE_COMMANDS') !== '1' && (!sameConfiguration || !hostWasRunning)) await stopOwnedSelfhostRelay();
        await startMuxrDaemon('selfhost', args, !sameConfiguration || !hostWasRunning);
        if (noPair) {
            print('Ready — existing paired devices will reconnect automatically.');
            return 0;
        }
        return await withSelfhostRotationLock(() => runSelfhostPair(state, pairKind, pairAuthority));
    } catch (cause) {
        if (pendingIngress && cloudflaredAlive(pendingIngress)) process.kill(Number(pendingIngress.pid), 'SIGTERM');
        error(cause instanceof Error ? cause.message : String(cause));
        return 1;
    }
}

export async function withSelfhostRotationLock(operation) {
    const lock = join(stateDir(), 'selfhost-rotation.lock');
    const claim = () => {
        try {
            writeFileSync(lock, `${JSON.stringify({ pid: process.pid, at: new Date().toISOString() })}\n`, { mode: 0o600, flag: 'wx' });
        } catch (cause) {
            if (cause?.code !== 'EEXIST') throw cause;
            const before = lstatSync(lock);
            let owner;
            try { owner = JSON.parse(readFileSync(lock, 'utf8')); }
            catch { throw new Error('pairing lock is unreadable; remove it only after confirming no muxr setup is running'); }
            if (!Number.isInteger(owner?.pid)) throw new Error('pairing lock has no process owner; remove it only after confirming no muxr setup is running');
            try {
                process.kill(owner.pid, 0);
                throw new Error(`another pairing or device rotation is running (pid ${owner.pid})`);
            } catch (error) {
                if (error?.code !== 'ESRCH') throw error;
            }
            const after = lstatSync(lock);
            if (after.ino !== before.ino || after.dev !== before.dev) return claim();
            rmSync(lock, { force: true });
            try {
                writeFileSync(lock, `${JSON.stringify({ pid: process.pid, at: new Date().toISOString() })}\n`, { mode: 0o600, flag: 'wx' });
            } catch (error) {
                if (error?.code === 'EEXIST') return claim();
                throw error;
            }
        }
    };
    claim();
    try { return await operation(); }
    finally { rmSync(lock, { force: true }); }
}

export async function selfhostDevices(state) {
    const result = await api(selfhostControlBase(state), `/v1/selfhost/devices?machine=${encodeURIComponent(state.machine.id)}`, {
        headers: { authorization: `Bearer ${selfhostCredential(state)}` },
    });
    if (!result.response.ok || !Array.isArray(result.body.devices)) {
        throw new Error(result.body.error || 'could not list paired devices; start the self-host relay first');
    }
    return result.body.devices;
}

export async function runDevices(command = 'list', args = []) {
    try {
        const state = readSelfhostState();
        if (state?.machine?.crypto === undefined || typeof selfhostCredential(state) !== 'string') {
            throw new Error('no self-host pairing state; run `muxr self-host` first');
        }
        if (command === 'list') {
            const devices = await selfhostDevices(state);
            if (devices.length === 0) print('No paired devices.');
            else devices.forEach((device, index) => print(`  ${index + 1}. ${device.name || 'phone'} — paired ${new Date(device.createdAt).toLocaleDateString()}`));
            return 0;
        }
        if (command !== 'revoke') throw new Error('usage: muxr devices list | muxr devices revoke <number|name>');
        await withSelfhostRotationLock(async () => {
            let current = readSelfhostState();
            let pending = current?.machine?.crypto?.pendingRotation;
            if (pending?.kind !== 'selfhost-revoke-v1') {
                const reference = args.join(' ').trim();
                if (reference === '') throw new Error('choose a device from `muxr devices list`');
                const devices = await selfhostDevices(current);
                const position = /^\d+$/.test(reference) ? Number(reference) - 1 : -1;
                const named = devices.filter((device) => device.name?.toLowerCase() === reference.toLowerCase());
                const target = position >= 0 ? devices[position] : named.length === 1 ? named[0] : undefined;
                if (target === undefined) throw new Error(named.length > 1 ? 'device name is ambiguous; use its list number' : 'device not found');
                const local = current.machine.crypto.devices;
                if (!local.some((device) => device.deviceId === target.deviceId)) {
                    const cleaned = await api(selfhostControlBase(current), `/v1/selfhost/devices/${encodeURIComponent(target.deviceId)}`, {
                        method: 'DELETE', headers: { authorization: `Bearer ${selfhostCredential(current)}` },
                    });
                    if (!cleaned.response.ok) throw new Error(cleaned.body.error || 'incomplete pairing cleanup failed');
                    print(`  ✓ revoked incomplete pairing for ${target.name || 'phone'}`);
                    return;
                }
                if (devices.some((device) => device.deviceId !== target.deviceId
                    && !local.some((entry) => entry.deviceId === device.deviceId))) {
                    throw new Error('another incomplete pairing exists; revoke it first');
                }
                const keyVersion = current.machine.crypto.keyVersion + 1;
                const dataKey = base64(nacl.randomBytes(32));
                const nextDevices = local.filter((device) => device.deviceId !== target.deviceId).map((device) => {
                    const expiresAt = device.kind === 'browser'
                        ? Math.min(Date.parse(device.expiresAt), Date.now() + BROWSER_GRANT_TTL_MS)
                        : DURABLE_GRANT_EXPIRES_AT;
                    return {
                        ...device,
                        ingressKey: base64(nacl.randomBytes(32)),
                        expiresAt: new Date(expiresAt).toISOString(),
                    };
                });
                const grants = nextDevices.map((device) => ({
                    deviceId: device.deviceId,
                    grant: JSON.stringify(createDeviceGrant({
                        machineId: current.machine.id,
                        machineSigningSecretKey: current.machine.crypto.signingSecretKey,
                        machineKey: { publicKey: current.machine.crypto.boxPublicKey, secretKey: current.machine.crypto.boxSecretKey },
                        deviceId: device.deviceId,
                        devicePublicKey: device.devicePublicKey,
                        dataKey,
                        ingressKey: device.ingressKey,
                        keyVersion,
                        expiresAt: Date.parse(device.expiresAt),
                        authority: device.authority ?? (device.kind === 'browser' ? 'observe' : 'control'),
                    })),
                }));
                pending = {
                    kind: 'selfhost-revoke-v1',
                    revokedDeviceId: target.deviceId,
                    revokedDeviceName: target.name || 'phone',
                    previousKeyVersion: current.machine.crypto.keyVersion,
                    keyVersion,
                    dataKey,
                    devices: nextDevices,
                    grants,
                };
                current.machine.crypto.pendingRotation = pending;
                writeSelfhostState(current);
            }

            const base = selfhostControlBase(current);
            const headers = { authorization: `Bearer ${selfhostCredential(current)}` };
            const revoked = await api(base, `/v1/selfhost/devices/${encodeURIComponent(pending.revokedDeviceId)}`, {
                method: 'DELETE', headers,
            });
            if (!revoked.response.ok && revoked.response.status !== 404) throw new Error(revoked.body.error || 'device credential revocation failed');

            current = readSelfhostState();
            if (current.machine.crypto.keyVersion === pending.previousKeyVersion) {
                current.machine.crypto.dataKey = pending.dataKey;
                current.machine.crypto.keyVersion = pending.keyVersion;
                current.machine.crypto.devices = pending.devices;
                writeSelfhostState(current);
            } else if (current.machine.crypto.keyVersion !== pending.keyVersion) {
                throw new Error('self-host key version changed during revocation; refusing to overwrite it');
            }

            // The host watches this atomic state file and hot-reloads keys.
            // Restarting the service here also restarts the relay; that can cut
            // off grant publication after clients have already been revoked,
            // stranding every remaining device on the previous generation.
            await new Promise((resolve) => setTimeout(resolve, 2500));
            const uploaded = await api(base, `/v1/selfhost/machines/${encodeURIComponent(current.machine.id)}/grants`, {
                method: 'POST',
                headers,
                body: JSON.stringify({
                    key_version: pending.keyVersion,
                    grants: pending.grants.map((entry) => ({ device_id: entry.deviceId, grant: entry.grant })),
                }),
            });
            if (!uploaded.response.ok) throw new Error(uploaded.body.error || 'rotated device grants were not published; rerun this command');
            current = readSelfhostState();
            if (current.machine.crypto.keyVersion !== pending.keyVersion) throw new Error('self-host key state changed before rotation completed');
            delete current.machine.crypto.pendingRotation;
            writeSelfhostState(current);
            print(`  ✓ revoked ${pending.revokedDeviceName}; remaining devices received fresh encryption keys`);
        });
        return 0;
    } catch (cause) {
        error(cause instanceof Error ? cause.message : String(cause));
        return 1;
    }
}

export async function runSelfhostPair(state, requestedKind = 'native', requestedAuthority = 'control') {
    const base = selfhostControlBase(state);
    const authHeaders = { authorization: `Bearer ${selfhostCredential(state)}` };
    let pending = state.machine.crypto.pendingPair;
    let recoveredPoll;
    if (pending !== undefined && typeof pending.expiresAt === 'number' && pending.expiresAt <= Date.now()) {
        // A claimed relay session remains recoverable after its local display
        // deadline. Poll once before discarding the only copy of its pair key.
        const polled = await api(base, `/v1/selfhost/pair-sessions/${encodeURIComponent(pending.pairId)}`, { headers: authHeaders });
        if (!polled.response.ok) {
            if (polled.response.status !== 403 && polled.response.status !== 404) throw new Error(polled.body.error || 'pair recovery polling failed');
            delete state.machine.crypto.pendingPair;
            writeSelfhostState(state);
            pending = undefined;
        } else if (polled.body.state === 'claimed') recoveredPoll = polled;
        else if (polled.body.state === 'expired') {
            delete state.machine.crypto.pendingPair;
            writeSelfhostState(state);
            pending = undefined;
        }
    }
    if (pending !== undefined && ((pending.deviceKind ?? 'native') !== requestedKind
        || (pending.authority ?? (pending.deviceKind === 'browser' ? 'observe' : 'control')) !== requestedAuthority
        || typeof pending.pairString !== 'string') && recoveredPoll === undefined) {
        delete state.machine.crypto.pendingPair;
        writeSelfhostState(state);
        pending = undefined;
    }
    if (pending === undefined) {
        const claim = randomBytes(32).toString('base64url');
        const pairSecret = randomBytes(32).toString('base64url');
        const created = await api(base, '/v1/selfhost/pair-sessions', {
            method: 'POST',
            headers: authHeaders,
            body: JSON.stringify({ claim, machineSlug: state.machine.id, deviceKind: requestedKind, authority: requestedAuthority }),
        });
        if (!created.response.ok) throw new Error(created.body.error || `pair session failed (${created.response.status})`);
        const payload = Buffer.from(JSON.stringify({
            v: '2',
            generation: String(state.machine.crypto.keyVersion),
            id: created.body.pair_id,
            claim,
            pair: pairSecret,
            machine: state.machine.id,
            name: state.machine.name ?? 'self-host',
            machinePk: state.machine.crypto.signingPublicKey,
            r: state.relayUrl,
            authority: requestedAuthority,
        })).toString('base64url');
        const code = newPairingCode();
        const published = await api(base, `/v1/selfhost/pair-sessions/${encodeURIComponent(created.body.pair_id)}/code`, {
            method: 'POST',
            headers: authHeaders,
            body: JSON.stringify({ code_hash: pairingCodeHash(code), payload: sealPairingCodePayload(payload, code) }),
        });
        if (!published.response.ok) throw new Error(published.body.error || 'pairing code publication failed');
        const locator = new URL(state.relayUrl);
        locator.searchParams.set('pair', code);
        if (requestedKind === 'browser') {
            locator.protocol = 'https:';
            locator.pathname = '/pair';
            locator.searchParams.set('role', requestedAuthority);
        }
        const pairString = locator.toString();
        pending = {
            pairId: created.body.pair_id,
            pairSecret,
            generation: state.machine.crypto.keyVersion,
            pairString,
            expiresAt: Date.now() + Number(created.body.expires_in ?? 120) * 1000,
            deviceKind: requestedKind,
            authority: requestedAuthority,
        };
        state.machine.crypto.pendingPair = pending;
        writeSelfhostState(state);
    }
    if (pending.grant !== undefined && pending.device !== undefined) {
        if (pending.grantUploaded !== true) {
            const uploaded = await api(base, `/v1/selfhost/pair-sessions/${encodeURIComponent(pending.pairId)}/grant`, {
                method: 'POST', headers: authHeaders, body: JSON.stringify({ grant: pending.grant }),
            });
            if (!uploaded.response.ok) throw new Error(uploaded.body.error || 'grant upload recovery failed');
            pending.grantUploaded = true;
            state.machine.crypto.pendingPair = pending;
            writeSelfhostState(state);
        }
        if (pending.deviceKind === 'browser') {
            const deadline = Date.now() + 2 * 60_000;
            let acknowledged = false;
            while (Date.now() < deadline) {
                const polled = await api(base, `/v1/selfhost/pair-sessions/${encodeURIComponent(pending.pairId)}`, { headers: authHeaders });
                if (!polled.response.ok) throw new Error(polled.body.error || 'pairing acknowledgement failed');
                if (polled.body.acknowledged === true) { acknowledged = true; break; }
                await new Promise((resolve) => setTimeout(resolve, 1000));
            }
            if (!acknowledged) throw new Error('the browser claimed the pairing but did not save it; reload the browser to recover, then rerun `muxr pair --browser` if needed');
        }
        state.machine.crypto.devices = [
            ...state.machine.crypto.devices.filter((entry) => entry.deviceId !== pending.device.deviceId),
            pending.device,
        ];
        delete state.machine.crypto.pendingPair;
        writeSelfhostState(state);
        print(`  ✓ paired and verified ${pending.deviceName || 'device'}`);
        return 0;
    }

    if (recoveredPoll === undefined) {
        print('');
        const browser = pending.deviceKind === 'browser';
        if (!browser) {
            print('Open the muxr app on your phone before scanning.');
            print('  Android: https://github.com/umeranjum17/muxr/releases/latest');
            print('  iPhone: install muxr from your TestFlight invitation');
            print('Not ready? Press Ctrl-C and run `muxr pair` later.');
            print('');
        }
        const pairValue = pending.pairString;
        if (typeof pairValue !== 'string') throw new Error('pairing string is unavailable');
        if (!browser && process.stdout.isTTY) await printTerminalQr(pairValue);
        print(browser
            ? `Open this ${pending.authority === 'observe' ? 'view-only' : 'control'} browser link within two minutes:`
            : 'Pairing string (expires in two minutes):');
        print(pairValue);
        if (browser) print('Browser access expires after eight hours.');
        const pairFile = join(stateDir(), 'pairing-string.txt');
        writeFileSync(pairFile, `${pairValue}\n`, { mode: 0o600 });
        // wl-copy/xclip stay alive as clipboard owners and can freeze setup in a
        // terminal or headless session. macOS pbcopy writes once and exits.
        const clipboard = hostPlatform() === 'darwin'
            ? spawnSync('pbcopy', [], { input: pairValue, timeout: 2_000 })
            : undefined;
        print(clipboard?.status === 0 ? '  ✓ copied link to clipboard' : `  saved exact link to ${pairFile}`);
        print(`Waiting for the ${browser ? 'browser' : 'device'} to finish pairing…`);
    }
    while (true) {
        let polled = recoveredPoll;
        recoveredPoll = undefined;
        if (polled === undefined) {
            await new Promise((resolve) => setTimeout(resolve, 2000));
            polled = await api(base, `/v1/selfhost/pair-sessions/${encodeURIComponent(pending.pairId)}`, { headers: authHeaders });
        }
        if (!polled.response.ok) throw new Error(polled.body.error || 'pair polling failed');
        if (polled.body.state === 'pending') continue;
        if (polled.body.state === 'expired') {
            delete state.machine.crypto.pendingPair;
            writeSelfhostState(state);
            if (requestedKind === 'native') {
                print('Pairing QR expired — creating a fresh one…');
                // ponytail: one promise frame per renewal; use an outer loop if unattended pairing lasts hours.
                return runSelfhostPair(state, requestedKind);
            }
            throw new Error('browser pairing session expired; run `muxr pair --browser` for a fresh link');
        }
        if (polled.body.state !== 'claimed') throw new Error(`pairing session ${polled.body.state}`);
        const mailbox = polled.body.mailbox;
        const deviceId = polled.body.deviceId;
        const devicePublicKey = polled.body.devicePublicKey;
        if (typeof mailbox !== 'string' || typeof deviceId !== 'string' || typeof devicePublicKey !== 'string') throw new Error('pairing mailbox is unavailable');
        const plaintext = openV2(mailbox, deriveV2Key(pending.pairSecret, 'client->host'), {
            machineId: state.machine.id,
            senderId: devicePublicKey,
            recipientId: state.machine.id,
            channel: 'pairing',
            streamId: pending.pairId,
            keyVersion: pending.generation ?? 1,
        }, newV2ReplayTracker());
        const request = JSON.parse(plaintext);
        if (request.devicePublicKey !== devicePublicKey || request.machineSigningPublicKey !== state.machine.crypto.signingPublicKey) {
            const mismatch = [
                request.devicePublicKey !== devicePublicKey && 'device',
                request.machineSigningPublicKey !== state.machine.crypto.signingPublicKey && 'machine',
            ].filter(Boolean).join(' and ');
            throw new Error(`pairing mailbox substitution rejected (${mismatch} key mismatch)`);
        }
        const ingressKey = base64(nacl.randomBytes(32));
        const browser = pending.deviceKind === 'browser';
        const authority = pending.authority ?? (browser ? 'observe' : 'control');
        if (polled.body.authority !== undefined && polled.body.authority !== authority) throw new Error('pairing authority substitution rejected');
        const expiresAt = browser ? Date.now() + BROWSER_GRANT_TTL_MS : DURABLE_GRANT_EXPIRES_AT;
        pending.device = {
            deviceId,
            devicePublicKey,
            ingressKey,
            expiresAt: new Date(expiresAt).toISOString(),
            authority,
            ...(browser ? { kind: 'browser' } : {}),
        };
        pending.deviceName = typeof request.deviceName === 'string' && request.deviceName.trim() !== '' ? request.deviceName.trim() : 'phone';
        pending.grant = JSON.stringify(createDeviceGrant({
            machineId: state.machine.id,
            machineSigningSecretKey: state.machine.crypto.signingSecretKey,
            machineKey: { publicKey: state.machine.crypto.boxPublicKey, secretKey: state.machine.crypto.boxSecretKey },
            deviceId,
            devicePublicKey,
            dataKey: state.machine.crypto.dataKey,
            ingressKey,
            keyVersion: state.machine.crypto.keyVersion,
            expiresAt,
            authority,
        }));
        state.machine.crypto.pendingPair = pending;
        writeSelfhostState(state);
        return runSelfhostPair(state, pending.deviceKind ?? 'native', authority);
    }
}

export async function runPair(args = []) {
    try {
        const state = readSelfhostState();
        if (state?.machine?.crypto === undefined || typeof selfhostCredential(state) !== 'string') {
            throw new Error('muxr is not set up yet; run `muxr setup` first');
        }
        const browser = args.includes('--browser') || args.includes('--browser-view');
        const authority = args.includes('--browser-view') ? 'observe' : 'control';
        if (browser && !browserHostingReady()) throw new Error('browser hosting is off. Run `muxr`, choose Pair or manage devices, then Pair a control browser — muxr can enable browser access on your current secure connection.');
        let healthy = await selfhostRelayHealthy(state);
        if (!healthy) {
            const definition = daemonDefinition('selfhost');
            if (existsSync(definition.path)) await runDaemon(['restart']);
            else if (state.relayLocation !== 'remote') await ensureSelfhostRelay(state.relayPort, state.webRoot, state.bindHost, state.webOrigin, relayDiscovery(state));
            healthy = await selfhostRelayHealthy(state);
        }
        if (!healthy) throw new Error('the relay could not restart; run `muxr doctor` for the exact failing check');
        return await withSelfhostRotationLock(() => runSelfhostPair(state, browser ? 'browser' : 'native', authority));
    } catch (cause) {
        error(cause instanceof Error ? cause.message : String(cause));
        return 1;
    }
}
