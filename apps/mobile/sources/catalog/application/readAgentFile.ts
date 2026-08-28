export type ReadAgentFileCommand = {
    agentRoute: string;
    path: string;
};

export type ReadAgentFileResult =
    | { ok: true; content: string }
    | { ok: false; message: string };

export type ReadAgentFilePorts = {
    read: (agentRoute: string, path: string) => Promise<{ content: string }>;
};

/** Read a workspace file through an Agent Route. */
export async function readAgentFile(
    command: ReadAgentFileCommand,
    ports: ReadAgentFilePorts,
): Promise<ReadAgentFileResult> {
    try {
        const result = await ports.read(command.agentRoute, command.path);
        return { ok: true, content: result.content };
    } catch (error) {
        return { ok: false, message: error instanceof Error ? error.message : String(error) };
    }
}
