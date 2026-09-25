/**
 * Device-local SSH tunnel to a relay that never leaves the host's loopback.
 *
 * The tunnel is transport only. Pairing, device grants, and end-to-end
 * encryption run inside it and stay authoritative, exactly as they do on
 * Tailscale. Credentials are passed straight through to the platform SSH
 * implementation and are never logged or persisted by this module.
 */

export interface SshTunnelConfig {
    host: string;
    port: number;
    username: string;
    password?: string;
    privateKey?: string;
    passphrase?: string;
    /** Pinned `SHA256:…` key. Omitted on the first connection, which returns the key to pin. */
    knownHostKey?: string;
    remoteHost: string;
    remotePort: number;
    /** Preferred device-local port. A busy port falls back to an ephemeral one. */
    localPort?: number;
}

export interface SshTunnelHandle {
    localPort: number;
    hostKey: string;
}

export interface SshCommandResult {
    stdout: string;
    stderr: string;
    exitCode: number;
}

export type SshTunnelErrorCode = 'ssh-unreachable' | 'ssh-auth' | 'ssh-host-key' | 'ssh-local-port' | 'ssh-configuration' | 'ssh-exec-timeout' | 'ssh-unsupported';

interface SshTunnelNative {
    openTunnel: (config: SshTunnelConfig) => Promise<SshTunnelHandle>;
    verifyCredentials: (config: SshTunnelConfig) => Promise<{ hostKey: string }>;
    execCommand: (config: SshTunnelConfig, command: string) => Promise<SshCommandResult>;
    closeTunnel: () => Promise<void>;
    tunnelPort: () => number;
    openForward: (remotePort: number) => Promise<{ localPort: number }>;
    closeForward: (localPort: number) => Promise<void>;
}

let native: SshTunnelNative | null | undefined;

function nativeModule(): SshTunnelNative | null {
    if (native !== undefined) return native;
    let platform: string | undefined;
    try {
        platform = (require('react-native') as { Platform?: { OS?: string } }).Platform?.OS;
    } catch {
        platform = undefined;
    }
    if (platform === undefined || platform === 'web') {
        native = null;
        return native;
    }
    // Keep native-module loading lazy so Node-side relay tests do not need the
    // Expo runtime globals that exist only inside a native bundle.
    const { requireOptionalNativeModule } = require('expo-modules-core') as typeof import('expo-modules-core');
    native = requireOptionalNativeModule<SshTunnelNative>('SshTunnel');
    return native;
}

export function isSshTunnelSupported(): boolean {
    return nativeModule() !== null;
}

export async function openSshTunnel(config: SshTunnelConfig): Promise<SshTunnelHandle> {
    const module = nativeModule();
    if (module === null) throw new SshTunnelError('ssh-unsupported', 'this build has no SSH support');
    try {
        return await module.openTunnel(config);
    } catch (error) {
        throw SshTunnelError.from(error);
    }
}

/** Sign in on a throwaway connection, leaving any live tunnel untouched. */
export async function verifySshCredentials(config: SshTunnelConfig): Promise<{ hostKey: string }> {
    const module = nativeModule();
    if (module === null) throw new SshTunnelError('ssh-unsupported', 'this build has no SSH support');
    try {
        return await module.verifyCredentials(config);
    } catch (error) {
        throw SshTunnelError.from(error);
    }
}

/** Run one already-reviewed command on the authenticated SSH account. */
export async function execSshCommand(config: SshTunnelConfig, command: string): Promise<SshCommandResult> {
    const module = nativeModule();
    if (module === null) throw new SshTunnelError('ssh-unsupported', 'this build has no SSH support');
    try {
        return await module.execCommand(config, command);
    } catch (error) {
        throw SshTunnelError.from(error);
    }
}

export async function closeSshTunnel(): Promise<void> {
    const module = nativeModule();
    if (module === null) return;
    await module.closeTunnel().catch(() => undefined);
}

/**
 * Forward one more host-loopback port over the live tunnel's own connection;
 * resolves to the device-local port to dial.
 */
export async function openSshForward(remotePort: number): Promise<number> {
    const module = nativeModule();
    if (module === null) throw new SshTunnelError('ssh-unsupported', 'this build has no SSH support');
    try {
        return (await module.openForward(remotePort)).localPort;
    } catch (error) {
        throw SshTunnelError.from(error);
    }
}

export async function closeSshForward(localPort: number): Promise<void> {
    const module = nativeModule();
    if (module === null) return;
    await module.closeForward(localPort).catch(() => undefined);
}

/** Device-local port of the live tunnel, or 0 when there is none. */
export function sshTunnelPort(): number {
    const module = nativeModule();
    return module === null ? 0 : module.tunnelPort();
}

export class SshTunnelError extends Error {
    constructor(readonly code: SshTunnelErrorCode, message: string) {
        super(message);
        this.name = 'SshTunnelError';
    }

    static from(error: unknown): SshTunnelError {
        const code = (error as { code?: unknown } | null)?.code;
        const known: SshTunnelErrorCode[] = ['ssh-unreachable', 'ssh-auth', 'ssh-host-key', 'ssh-local-port', 'ssh-configuration', 'ssh-exec-timeout', 'ssh-unsupported'];
        const message = error instanceof Error ? error.message : String(error);
        return new SshTunnelError(
            known.find((candidate) => candidate === code) ?? 'ssh-unreachable',
            message,
        );
    }
}
