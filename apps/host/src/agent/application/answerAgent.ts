import type { SessionSource } from './sessionSource.js';

export type AnswerAgentCommand = { sessionId: string; answer: 'y' | 'n' };

export type AnswerAgentResult = { ok: true; data: null } | { ok: false; error: string };

/** The Agent's y/n prompt is answered by typing the literal key. */
export async function answerAgent(
    sessions: Pick<SessionSource, 'sendKeys'>,
    command: AnswerAgentCommand,
): Promise<AnswerAgentResult> {
    await sessions.sendKeys(command.sessionId, [command.answer]);
    return { ok: true, data: null };
}
