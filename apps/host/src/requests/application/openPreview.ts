export type OpenPreviewCommand = {
    channel: string;
    port: number;
    key?: string;
    mode?: 'observe' | 'control';
};

export type OpenPreviewResult = { ok: true; data: null } | { ok: false; error: string };

export interface OpenPreviewPorts {
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
        mode?: 'observe' | 'control';
        token?: string;
        onChannelClose?: (channel: string) => void;
    }): Promise<null>;
}

/**
 * Port -> controlling channel. Only explicit takeover claims register here:
 * dev-server previews omit `mode` and keep sharing a port as before, and
 * watchers never hold control. The holder is released when its relay socket
 * closes, so a dead controller never blocks the stream.
 */
const controllers = new Map<number, string>();

export function releasePreviewControl(channel: string): void {
    for (const [port, holder] of controllers) {
        if (holder === channel) controllers.delete(port);
    }
}

export async function openPreview(ports: OpenPreviewPorts, command: OpenPreviewCommand): Promise<OpenPreviewResult> {
    if (ports.relayUrl === undefined) return { ok: false, error: 'preview: host has no relay url' };
    if (ports.requireEncryption === true && command.key === undefined) {
        return { ok: false, error: 'preview: update the app to use encrypted preview' };
    }
    if (command.mode !== undefined && command.mode !== 'observe' && command.mode !== 'control') {
        return { ok: false, error: 'preview: unknown attach mode' };
    }
    if (command.mode === 'control') {
        const holder = controllers.get(command.port);
        if (holder !== undefined && holder !== command.channel) {
            return { ok: false, error: `takeover: stream port ${command.port} is controlled by another device` };
        }
        controllers.set(command.port, command.channel);
    }
    try {
        await ports.attach({
            relayUrl: ports.relayUrl,
            machineId: ports.machineId,
            channel: command.channel,
            port: command.port,
            ...(command.key === undefined ? {} : { key: command.key }),
            ...(command.mode === undefined ? {} : { mode: command.mode }),
            ...(ports.token === undefined ? {} : { token: ports.token }),
            ...(command.mode === 'control' ? { onChannelClose: releasePreviewControl } : {}),
        });
    } catch (error) {
        if (command.mode === 'control') releasePreviewControl(command.channel);
        throw error;
    }
    return { ok: true, data: null };
}

export type ProbePreviewCommand = { port: number };
export type ProbePreviewResult = { ok: true; data: { contentType: string | null } };

export async function probePreview(
    probe: (port: number) => Promise<string | null>,
    command: ProbePreviewCommand,
): Promise<ProbePreviewResult> {
    return { ok: true, data: { contentType: await probe(command.port) } };
}
