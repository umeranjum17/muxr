export type ResumeCommandMetadata = {
    path?: string | null;
    os?: string | null;
    flavor?: string | null;
    claudeSessionId?: string | null;
    codexThreadId?: string | null;
    client?: { id?: string | null } | null;
    capabilities?: { resume?: boolean | null } | null;
};

export type ResumeCommandBlock = {
    lines: string[];
    copyText: string;
};

// muxr resumes supported Pi sessions through the host request path, never by
// suggesting an inherited third-party wrapper command in the user's terminal.
export function buildResumeCommandBlock(_metadata: ResumeCommandMetadata): ResumeCommandBlock | null {
    return null;
}

export function buildResumeCommand(_metadata: ResumeCommandMetadata): string | null {
    return null;
}
