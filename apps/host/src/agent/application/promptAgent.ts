import type { SessionPromptOptions, SessionSource } from './sessionSource.js';

export type PromptAgentCommand = SessionPromptOptions;

export type PromptAgentResult = { ok: true; data: null } | { ok: false; error: string; code?: string };

export async function promptAgent(
    sessions: Pick<SessionSource, 'prompt'>,
    command: PromptAgentCommand,
): Promise<PromptAgentResult> {
    try {
        await sessions.prompt(command);
        return { ok: true, data: null };
    } catch (error) {
        const code = (error as { code?: unknown }).code;
        return {
            ok: false,
            error: error instanceof Error ? error.message : String(error),
            ...(typeof code === 'string' ? { code } : {}),
        };
    }
}
