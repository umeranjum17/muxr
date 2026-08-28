export type OpenPreviewCommand = {
    channel: string;
    port: number;
    key?: string;
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
        token?: string;
    }): Promise<null>;
}

export async function openPreview(ports: OpenPreviewPorts, command: OpenPreviewCommand): Promise<OpenPreviewResult> {
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

export type ProbePreviewCommand = { port: number };
export type ProbePreviewResult = { ok: true; data: { contentType: string | null } };

export async function probePreview(
    probe: (port: number) => Promise<string | null>,
    command: ProbePreviewCommand,
): Promise<ProbePreviewResult> {
    return { ok: true, data: { contentType: await probe(command.port) } };
}
