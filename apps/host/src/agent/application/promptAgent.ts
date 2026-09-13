import type { SessionPromptOptions, SessionSource } from './sessionSource.js';

export type PromptAgentCommand = SessionPromptOptions;

export type PromptAgentResult =
    | { ok: true; data: null }
    /** `dispatched`: the failure came after the prompt may have reached Herdr, so it is uncertain, not a refusal. */
    | { ok: false; error: string; code?: string; dispatched?: true };

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
            ...((error as { promptDispatched?: unknown }).promptDispatched === true ? { dispatched: true } : {}),
        };
    }
}
