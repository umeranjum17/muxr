import type { SessionPromptOptions, SessionSource } from './sessionSource.js';

export type PromptAgentCommand = SessionPromptOptions;

export type PromptAgentResult = { ok: true; data: null } | { ok: false; error: string };

export async function promptAgent(
    sessions: Pick<SessionSource, 'prompt'>,
    command: PromptAgentCommand,
): Promise<PromptAgentResult> {
    await sessions.prompt(command);
    return { ok: true, data: null };
}
