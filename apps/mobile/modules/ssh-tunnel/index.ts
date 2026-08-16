import { requireOptionalNativeModule } from 'expo-modules-core';
import * as SecureStore from 'expo-secure-store';
import { decodeBase64 } from '@/encryption/base64';

export interface SshConfig {
    host: string;
    port?: number;
    username: string;
    password?: string;
    privateKey?: string;
}

interface SshTunnelNative {
    connect(config: Record<string, unknown>, pinnedFingerprint: string | null): Promise<string>;
    forwardLocal(localPort: number, remoteHost: string, remotePort: number): Promise<boolean>;
    close(): Promise<boolean>;
}

const native = requireOptionalNativeModule<SshTunnelNative>('SshTunnel');
const PIN_KEY = (host: string, port: number) => `muxr.ssh.hostkey.${host}-${port}`;

/**
 * Connect an SSH tunnel with trust-on-first-use host-key pinning. Returns the
 * host fingerprint on first connect; later connects verify against the pin.
 */
export async function connectSshTunnel(config: SshConfig, forward: { localPort: number; remoteHost: string; remotePort: number }): Promise<{ fingerprint: string; pinned: boolean }> {
    if (native === null) throw new Error('SSH tunnel is unavailable in this build');
    const port = config.port ?? 22;
    const pinKey = PIN_KEY(config.host, port);
    const pinned = await SecureStore.getItemAsync(pinKey);
    const resolved = { ...config };
    // The settings field takes a base64 blob (single-line paste); PEM goes through as-is.
    if (resolved.privateKey !== undefined && !resolved.privateKey.includes('BEGIN')) {
        resolved.privateKey = Array.from(decodeBase64(resolved.privateKey), (b) => String.fromCharCode(b)).join('');
    }
    const fingerprint = await native.connect({ ...resolved } as Record<string, unknown>, pinned);
    if (pinned === null) await SecureStore.setItemAsync(pinKey, fingerprint);
    await native.forwardLocal(forward.localPort, forward.remoteHost, forward.remotePort);
    return { fingerprint, pinned: pinned !== null };
}

/** The fingerprint trusted on this server's first connection, if there is one. */
export async function getPinnedHostKey(host: string, port = 22): Promise<string | undefined> {
    if (host.trim() === '') return undefined;
    return (await SecureStore.getItemAsync(PIN_KEY(host.trim(), port))) ?? undefined;
}

/**
 * Drop the pin so the next connection trusts a new key. Needed after a genuine
 * server rebuild, which from this phone looks identical to an attack.
 */
export async function forgetPinnedHostKey(host: string, port = 22): Promise<void> {
    if (host.trim() === '') return;
    await SecureStore.deleteItemAsync(PIN_KEY(host.trim(), port));
}

export async function closeSshTunnel(): Promise<void> {
    await native?.close();
}
