import {
    closeSshTunnel,
    isSshTunnelSupported,
    openSshTunnel,
    SshTunnelError,
    type SshTunnelErrorCode,
} from '../../../modules/ssh-tunnel';
import type { SshTarget } from './connectionSettings';

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

/** Actionable failure for a tunnel that could not carry the session. */
export class SshConnectionError extends Error {
    constructor(readonly code: SshTunnelErrorCode, message: string, readonly permanent: boolean) {
        super(message);
        this.name = 'SshConnectionError';
    }
}

function describe(error: SshTunnelError, target: SshTarget): SshConnectionError {
    const where = `${target.username}@${target.host}:${target.port}`;
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

/** True when this connection reaches its relay through SSH. */
export function sshTunnelAvailable(): boolean {
    return isSshTunnelSupported();
}

export async function stopSshTunnel(): Promise<void> {
    await closeSshTunnel();
}

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
    const path = remote.pathname === '/' ? '' : remote.pathname;
    return `ws://127.0.0.1:${handle.localPort}${path}`;
}
