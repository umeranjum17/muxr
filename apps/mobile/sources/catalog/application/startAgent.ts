export type StartAgentCommand = {
    directory: string;
    kind?: string;
    parentAgentRoute?: string;
    createDirectory?: boolean;
};

export type StartAgentHostSnapshot =
    | { info: { id: string } }
    | { acceptance?: object };

export type StartAgentResult =
    | { ok: true; agentRoute: string }
    | { ok: false; reason: 'missing-directory'; directory: string }
    | { ok: false; reason: 'rejected'; message: string };

export type StartAgentPorts = {
    startOnHost: (input: {
        directory: string;
        createDirectory?: true;
        kind?: string;
        parentAgentRoute?: string;
    }) => Promise<StartAgentHostSnapshot>;
    waitUntilListed: (agentRoute: string) => Promise<unknown>;
    missingDirectory: (message: string) => boolean;
};

/** Start an Agent on the connected machine. */
export async function startAgent(command: StartAgentCommand, ports: StartAgentPorts): Promise<StartAgentResult> {
    try {
        const snapshot = await ports.startOnHost({
            directory: command.directory,
            ...(command.createDirectory === true ? { createDirectory: true as const } : {}),
            ...(command.parentAgentRoute === undefined ? {} : { parentAgentRoute: command.parentAgentRoute }),
            ...(command.kind === undefined ? {} : { kind: command.kind }),
        });
        if (!('info' in snapshot)) {
            return {
                ok: false,
                reason: 'rejected',
                message: 'Agent could not start.',
            };
        }
        await ports.waitUntilListed(snapshot.info.id);
        return { ok: true, agentRoute: snapshot.info.id };
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (ports.missingDirectory(message)) {
            return { ok: false, reason: 'missing-directory', directory: command.directory };
        }
        return { ok: false, reason: 'rejected', message: 'Agent could not start. Try again.' };
    }
}
