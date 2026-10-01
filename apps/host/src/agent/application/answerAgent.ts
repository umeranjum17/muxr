import type { SessionSource } from './sessionSource.js';

export type AnswerAgentCommand = { sessionId: string; answer: string; eventId?: string };

export type AnswerAgentResult = { ok: true; data: null } | { ok: false; error: string };

/**
 * A blocked Agent is answered by one key: `y`/`n`, or a choice's number,
 * which selects and confirms it. Herdr types keys, not text, into a waiting
 * dialog, so longer replies are refused rather than half-typed.
 */
export async function answerAgent(
    sessions: Pick<SessionSource, 'sendKeys'>,
    command: AnswerAgentCommand,
): Promise<AnswerAgentResult> {
    const answer = typeof command.answer === 'string' ? command.answer.trim() : '';
    if (!/^[\p{L}\p{N}]$/u.test(answer)) return { ok: false, error: 'Answer with one key, like y, n or a choice number.' };
    if (command.eventId !== undefined && (typeof command.eventId !== 'string' || command.eventId.length > 64)) {
        return { ok: false, error: 'That question was already answered or changed.' };
    }
    await sessions.sendKeys(command.sessionId, [answer], command.eventId === undefined ? undefined : { eventId: command.eventId });
    return { ok: true, data: null };
}
