import {
    closeSshForward,
    closeSshTunnel,
    execSshCommand,
    isSshTunnelSupported,
    openSshForward,
    openSshTunnel,
    sshTunnelPort,
    SshTunnelError,
    verifySshCredentials,
    type SshCommandResult,
    type SshTunnelErrorCode,
} from '../../modules/ssh-tunnel';
import type { SshTarget } from './connectionSettings';
import { sameSshTarget } from './sshKeyInstall';
import type { SshPublicKeyInfo } from './sshPublicKey';

/**
 * Direct SSH reachability for a relay that stays on the host's loopback.
 *
 * The tunnel carries the ordinary relay socket, so pairing, device grants, and
 * end-to-end encryption are unchanged and still decide who may drive the
 * machine. SSH decides only which route the bytes take.
 */

const CREDENTIAL_PREFIX = 'muxr.ssh.credential.v1.';

/** Auth material for one host. Lives in the device secure store, never in settings or logs. */
export interface SshCredential {
    privateKey?: string;
    passphrase?: string;
    password?: string;
}

function credentialKey(machineId: string): string {
    return `${CREDENTIAL_PREFIX}${machineId}`;
}

export async function saveSshCredential(machineId: string, credential: SshCredential): Promise<void> {
    if (!isSshTunnelSupported()) throw new SshConnectionError('ssh-unsupported', 'this build has no SSH support', true);
    const { setNativeSecret } = await import('@/pairing/secrets');
    await setNativeSecret(credentialKey(machineId), JSON.stringify(credential));
}

export async function forgetSshCredential(machineId: string): Promise<void> {
    if (!isSshTunnelSupported()) return;
    const { deleteNativeSecret } = await import('@/pairing/secrets');
    await deleteNativeSecret(credentialKey(machineId));
}

export async function hasSshCredential(machineId: string): Promise<boolean> {
    if (!isSshTunnelSupported()) return false;
    const { getNativeSecret } = await import('@/pairing/secrets');
    return (await getNativeSecret(credentialKey(machineId))) !== null;
}

async function readCredential(machineId: string): Promise<SshCredential | undefined> {
    const { getNativeSecret } = await import('@/pairing/secrets');
    const raw = await getNativeSecret(credentialKey(machineId));
    if (raw === null) return undefined;
    try {
        return JSON.parse(raw) as SshCredential;
    } catch {
        return undefined;
    }
}

/** Derive public metadata from the saved private key without exposing the private bytes. */
export async function savedSshPublicKey(machineId: string): Promise<SshPublicKeyInfo | undefined> {
    if (!isSshTunnelSupported() || machineId === '') return undefined;
    const credential = await readCredential(machineId);
    if (credential?.privateKey === undefined) return undefined;
    const { sshPublicKeyFromPrivate } = await import('./sshPublicKey');
    return sshPublicKeyFromPrivate(credential.privateKey);
}

/** Actionable failure for a tunnel that could not carry the session. */
export class SshConnectionError extends Error {
    constructor(readonly code: SshTunnelErrorCode, message: string, readonly permanent: boolean) {
        super(message);
        this.name = 'SshConnectionError';
    }
}

function describe(error: SshTunnelError, target: SshTarget): SshConnectionError {
    const where = `${target.username}@${target.host}:${target.port}`;
    if (/ed25519/i.test(error.message)) {
        return new SshConnectionError(
            error.code,
            'This route needs RSA or ECDSA SSH keys: an Ed25519 host or login key is in use, which muxr does not support yet. Use an RSA host key and an RSA or ECDSA login key on the machine.',
            true,
        );
    }
    switch (error.code) {
        case 'ssh-auth':
            return new SshConnectionError(
                error.code,
                `${where} refused these credentials. Check the username, and that this device's public key is in ~/.ssh/authorized_keys on the machine.`,
                true,
            );
        case 'ssh-host-key':
            return new SshConnectionError(
                error.code,
                `The SSH host key for ${target.host} changed, so muxr did not connect. If you rebuilt or replaced that machine, choose 'Use current relay route instead' in Connection settings to clear the Direct SSH route, then save SSH again to trust the new key; otherwise treat it as an interception.`,
                true,
            );
        case 'ssh-unsupported':
            return new SshConnectionError(
                error.code,
                'This build of muxr cannot open SSH connections. Use the app from the store or a development build, or reach this machine over Tailscale or your network.',
                true,
            );
        case 'ssh-local-port':
            return new SshConnectionError(error.code, 'This device could not open a local port for the SSH tunnel. Close other apps and try again.', false);
        case 'ssh-configuration':
            return new SshConnectionError(error.code, 'This SSH route is limited to muxr’s host-loopback relay.', true);
        default:
            return new SshConnectionError(
                error.code,
                `Could not reach ${where}. Check that the machine is awake, that its SSH server is running, and that this phone can reach that address.`,
                false,
            );
    }
}

/**
 * The relay is reached through the Direct SSH tunnel right now. The remote
 * desktop then cannot count on a UDP path of its own, so its picture is also
 * offered over TCP and carried through this same SSH connection.
 */
export function sshRouteActive(): boolean {
    return isSshTunnelSupported() && sshTunnelPort() > 0;
}

export { closeSshForward, openSshForward };

/** True when this connection reaches its relay through SSH. */
export function sshTunnelAvailable(): boolean {
    return isSshTunnelSupported();
}

/** Raw Direct SSH form input, as typed: ports are strings until validated. */
export interface SshFieldInput {
    host: string;
    username: string;
    port: string;
    relayPort: string;
    password: string;
    privateKey: string;
    passphrase: string;
    /** A saved credential already in the secure store counts as auth material. */
    credentialPresent?: boolean;
}

function portFromField(raw: string, fallback: number): number | undefined {
    const value = raw.trim();
    if (value === '') return fallback;
    if (!/^\d{1,5}$/.test(value)) return undefined;
    const port = Number(value);
    return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : undefined;
}

/**
 * The one validator for every Direct SSH form. Returns user-readable error
 * copy or the parsed target and credential, so the settings screen and the
 * first-run SSH route cannot drift apart.
 */
export function parseSshFields(input: SshFieldInput): { target: SshTarget; credential: SshCredential } | { error: string } {
    const host = input.host.trim();
    const username = input.username.trim();
    const port = portFromField(input.port, 22);
    const relayPort = portFromField(input.relayPort, 8792);
    if (host === '' || username === '') {
        return { error: 'Enter the SSH host and username from the machine you want to reach.' };
    }
    if (port === undefined || relayPort === undefined) {
        return { error: 'SSH and relay ports must be numbers from 1 to 65535.' };
    }
    if (input.password !== '' && input.privateKey !== '') {
        return { error: 'Choose one SSH login method: password or private key.' };
    }
    if (input.passphrase !== '' && input.privateKey === '') {
        return { error: 'Paste the private key before entering its passphrase.' };
    }
    if (input.password === '' && input.privateKey === '' && input.credentialPresent !== true) {
        return { error: 'Enter an SSH password or private key. It is stored only in this device’s secure store.' };
    }
    const target: SshTarget = { host, username, port, relayPort };
    const credential: SshCredential = {
        ...(input.privateKey === '' ? {} : { privateKey: input.privateKey }),
        ...(input.passphrase === '' ? {} : { passphrase: input.passphrase }),
        ...(input.password === '' ? {} : { password: input.password }),
    };
    return { target, credential };
}

/**
 * Keep a host key already pinned for the same endpoint; a new endpoint pairs
 * fresh and pins on first successful connect.
 */
export function pinSshHostKey(previous: SshTarget | undefined, next: SshTarget): SshTarget {
    return previous !== undefined
        && previous.host === next.host && previous.port === next.port
        && previous.username === next.username && previous.relayPort === next.relayPort
        && previous.hostKey !== undefined
        ? { ...next, hostKey: previous.hostKey }
        : next;
}

/**
 * Prove a just-entered credential signs in, on a connection of its own. A live
 * tunnel is reused by endpoint alone, so without this a wrong key rides the
 * old tunnel and looks fine until that tunnel drops. The live tunnel is never
 * touched, so a failure here leaves a working route as it was.
 */
export async function verifySshCredential(target: SshTarget, credential: SshCredential): Promise<string> {
    try {
        const { hostKey } = await verifySshCredentials({
            host: target.host,
            port: target.port,
            username: target.username,
            ...(credential.privateKey ? { privateKey: credential.privateKey } : {}),
            ...(credential.passphrase ? { passphrase: credential.passphrase } : {}),
            ...(credential.password ? { password: credential.password } : {}),
            ...(target.hostKey ? { knownHostKey: target.hostKey } : {}),
            remoteHost: '127.0.0.1',
            remotePort: target.relayPort,
        });
        return hostKey;
    } catch (error) {
        throw describe(error instanceof SshTunnelError ? error : SshTunnelError.from(error), target);
    }
}

/**
 * Establish the SSH tunnel for a not-yet-paired SSH route BEFORE any claim:
 * the pairing then completes through ws://127.0.0.1:<localPort>, so success
 * always implies a working tunnel. Reuses an alive identical tunnel, but only
 * after the entered credential has signed in on its own.
 */
export async function establishSshTunnel(input: SshFieldInput): Promise<{ ok: true; localPort: number; hostKey: string | undefined } | { ok: false; message: string }> {
    if (!isSshTunnelSupported()) {
        return { ok: false, message: 'This build of muxr cannot open SSH connections. Use the store app or another supported build.' };
    }
    const parsed = parseSshFields(input);
    if ('error' in parsed) return { ok: false, message: parsed.error };
    try {
        const verifiedHostKey = await verifySshCredential(parsed.target, parsed.credential);
        const handle = await openSshTunnel({
            host: parsed.target.host,
            port: parsed.target.port,
            username: parsed.target.username,
            ...(parsed.credential.privateKey ? { privateKey: parsed.credential.privateKey } : {}),
            ...(parsed.credential.passphrase ? { passphrase: parsed.credential.passphrase } : {}),
            ...(parsed.credential.password ? { password: parsed.credential.password } : {}),
            // The self-host relay deliberately stays on the host's loopback.
            remoteHost: '127.0.0.1',
            remotePort: parsed.target.relayPort,
            localPort: parsed.target.relayPort,
        });
        if (handle.hostKey !== verifiedHostKey) throw describe(new SshTunnelError('ssh-host-key', 'the SSH host key changed'), parsed.target);
        return { ok: true, localPort: handle.localPort, hostKey: handle.hostKey };
    } catch (error) {
        if (error instanceof SshConnectionError) return { ok: false, message: error.message };
        const described = describe(error instanceof SshTunnelError ? error : SshTunnelError.from(error), parsed.target);
        return { ok: false, message: described.message };
    }
}

/** Rewrite a pairing URL to dial through the established tunnel instead. */
export function tunnelPairingUrl(pairingUrl: string, localPort: number): string {
    try {
        const remote = new URL(pairingUrl);
        if (!['ws:', 'wss:'].includes(remote.protocol)) return pairingUrl;
        const path = remote.pathname === '/' ? '' : remote.pathname;
        return `ws://127.0.0.1:${localPort}${path}${remote.search}`;
    } catch {
        return pairingUrl;
    }
}

/**
 * Persist the SSH route a user filled in before pairing, once the pairing
 * grant has landed and the machine id exists. Pairing itself is unchanged:
 * this only decides which route the bytes take afterwards. The claim may have
 * run through the just-established tunnel, in which case the machine's real
 * relay address is restored here so the stored settings stay truthful.
 */
export async function applySshAfterPairing(input: SshFieldInput, options?: { hostKey?: string; relayUrl?: string }): Promise<{ ok: true } | { ok: false; message: string }> {
    if (!isSshTunnelSupported()) {
        return { ok: false, message: 'This build of muxr cannot open SSH connections, so the Direct SSH route was not applied.' };
    }
    const parsed = parseSshFields(input);
    if ('error' in parsed) return { ok: false, message: parsed.error };
    const { getCachedConnectionSettings, saveConnectionSettings } = await import('./connectionSettings');
    const settings = getCachedConnectionSettings();
    if (settings.selfhost !== true || settings.machineId === '') {
        return { ok: false, message: 'This pairing is not self-hosted, so the Direct SSH route was not applied. The connection uses the paired relay route.' };
    }
    try {
        await saveSshCredential(settings.machineId, parsed.credential);
        let target = pinSshHostKey(settings.ssh, parsed.target);
        if (options?.hostKey !== undefined && target.hostKey === undefined) {
            // Trust on first use: the key seen while the tunnel was established
            // during pairing becomes this route's authority.
            target = { ...target, hostKey: options.hostKey };
        }
        await saveConnectionSettings({
            ...settings,
            ssh: target,
            ...(options?.relayUrl !== undefined ? { relayUrl: options.relayUrl } : {}),
        });
        return { ok: true };
    } catch (cause) {
        return { ok: false, message: cause instanceof Error ? cause.message : String(cause) };
    }
}

export async function stopSshTunnel(): Promise<void> {
    await closeSshTunnel();
}

/** Execute a reviewed command on the pinned, saved Direct SSH target. */
export async function executeSshCommand(machineId: string, target: SshTarget, command: string): Promise<SshCommandResult> {
    if (!isSshTunnelSupported()) throw new SshConnectionError('ssh-unsupported', 'this build has no SSH support', true);
    const { getCachedConnectionSettings } = await import('./connectionSettings');
    const settings = getCachedConnectionSettings();
    if (settings.selfhost !== true || settings.machineId !== machineId || !sameSshTarget(settings.ssh, target) || target.hostKey === undefined) {
        throw new SshConnectionError('ssh-configuration', 'The Direct SSH target changed. Review the target and command before trying again.', true);
    }
    const credential = await readCredential(machineId);
    if (credential === undefined) {
        throw new SshConnectionError('ssh-auth', `muxr has no saved SSH credential for ${target.username}@${target.host}. Add it in Connection settings.`, true);
    }
    try {
        const result = await execSshCommand({
            host: target.host,
            port: target.port,
            username: target.username,
            ...(credential.privateKey ? { privateKey: credential.privateKey } : {}),
            ...(credential.passphrase ? { passphrase: credential.passphrase } : {}),
            ...(credential.password ? { password: credential.password } : {}),
            knownHostKey: target.hostKey,
            remoteHost: '127.0.0.1',
            remotePort: target.relayPort,
            localPort: target.relayPort,
        }, command);
        return result;
    } catch (error) {
        if (error instanceof SshTunnelError) {
            if (error.code === 'ssh-exec-timeout') {
                throw new SshConnectionError(error.code, 'The SSH command did not finish; its outcome is unknown. Inspect authorized_keys before trying again.', true);
            }
            throw describe(error, target);
        }
        throw describe(SshTunnelError.from(error), target);
    }
}

const pendingRelayTunnels = new Map<string, Promise<number>>();

/**
 * Open or reuse the tunnel and return the URL to dial. Callers run this
 * immediately before every dial, so a tunnel dropped by a network change is
 * rebuilt by the same retry that reopens the socket.
 */
export async function sshRelayUrl(relayUrl: string, machineId: string, target: SshTarget): Promise<string> {
    if (!isSshTunnelSupported()) {
        throw new SshConnectionError('ssh-unsupported', 'this build has no SSH support', true);
    }
    let remote: URL;
    try {
        remote = new URL(relayUrl);
        if (!['ws:', 'wss:'].includes(remote.protocol)) throw new Error('unsupported relay protocol');
    } catch {
        throw new SshConnectionError('ssh-unreachable', 'This machine has no usable relay address. Pair it again from the computer.', true);
    }
    const { getCachedConnectionSettings, saveConnectionSettings } = await import('./connectionSettings');
    const settings = getCachedConnectionSettings();
    const activeTarget = settings.machineId === machineId && settings.ssh !== undefined ? settings.ssh : target;
    const key = JSON.stringify([machineId, activeTarget.host, activeTarget.port, activeTarget.username, activeTarget.relayPort, activeTarget.hostKey]);
    let pending = pendingRelayTunnels.get(key);
    if (pending === undefined) {
        pending = (async () => {
            try {
                const credential = await readCredential(machineId);
                if (credential === undefined) {
                    throw new SshConnectionError('ssh-auth', `muxr has no saved SSH key or password for ${activeTarget.username}@${activeTarget.host}. Add it in Connection settings.`, true);
                }
                let handle;
                try {
                    handle = await openSshTunnel({
                        host: activeTarget.host,
                        port: activeTarget.port,
                        username: activeTarget.username,
                        ...(credential.privateKey ? { privateKey: credential.privateKey } : {}),
                        ...(credential.passphrase ? { passphrase: credential.passphrase } : {}),
                        ...(credential.password ? { password: credential.password } : {}),
                        ...(activeTarget.hostKey ? { knownHostKey: activeTarget.hostKey } : {}),
                        // The self-host relay deliberately stays on the host's loopback;
                        // the public/Tailscale hostname is not a valid SSH destination.
                        remoteHost: '127.0.0.1',
                        remotePort: activeTarget.relayPort,
                        localPort: activeTarget.relayPort,
                    });
                } catch (error) {
                    throw describe(error instanceof SshTunnelError ? error : SshTunnelError.from(error), activeTarget);
                }
                // Trust on first use: the key seen while pairing becomes the authority for
                // this route from then on. A later mismatch fails closed above.
                if (activeTarget.hostKey === undefined && settings.machineId === machineId && settings.ssh !== undefined) {
                    await saveConnectionSettings({ ...settings, ssh: { ...settings.ssh, hostKey: handle.hostKey } });
                }
                return handle.localPort;
            } finally {
                pendingRelayTunnels.delete(key);
            }
        })();
        pendingRelayTunnels.set(key, pending);
    }
    const localPort = await pending;
    const path = remote.pathname === '/' ? '' : remote.pathname;
    return `ws://127.0.0.1:${localPort}${path}`;
}

/**
 * Where a side channel (terminal, preview, stream) to `machineId` dials its
 * relay: through the same SSH tunnel as sync when SSH is that machine's route,
 * because over SSH alone the relay's own address is not reachable at all.
 */
export async function channelRelayUrl(relayUrl: string, machineId: string): Promise<string> {
    const { getCachedConnectionSettings } = await import('./connectionSettings');
    const settings = getCachedConnectionSettings();
    if (settings.machineId !== machineId || settings.selfhost !== true || settings.ssh === undefined || !isSshTunnelSupported()) return relayUrl;
    return sshRelayUrl(relayUrl, machineId, settings.ssh);
}
