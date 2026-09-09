export type AttachPreviewTunnelCommand = {
    channel: string;
    port: number;
    key?: string;
};

export type AttachPreviewTunnelResult = { ok: true; data: null } | { ok: false; error: string };

export interface AttachPreviewTunnelPorts {
    relayUrl?: string;
    machineId: string;
    token?: string;
    requireEncryption?: boolean;
    attach(input: {
        relayUrl: string;
        machineId: string;
        channel: string;
        port: number;
        key?: string;
        token?: string;
    }): Promise<null>;
}

export async function attachPreviewTunnel(
    ports: AttachPreviewTunnelPorts,
    command: AttachPreviewTunnelCommand,
): Promise<AttachPreviewTunnelResult> {
    if (ports.relayUrl === undefined) return { ok: false, error: 'preview: host has no relay url' };
    if (ports.requireEncryption === true && command.key === undefined) {
        return { ok: false, error: 'preview: update the app to use encrypted preview' };
    }
    await ports.attach({
        relayUrl: ports.relayUrl,
        machineId: ports.machineId,
        channel: command.channel,
        port: command.port,
        ...(command.key === undefined ? {} : { key: command.key }),
        ...(ports.token === undefined ? {} : { token: ports.token }),
    });
    return { ok: true, data: null };
}
