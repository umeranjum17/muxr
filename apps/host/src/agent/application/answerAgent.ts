import type { SessionSource } from './sessionSource.js';

export type AnswerAgentCommand = { sessionId: string; answer: string; eventId?: string };

export type AnswerAgentResult = { ok: true; data: null } | { ok: false; error: string };

/**
 * One-key choices keep their existing behavior. A short text answer is sent as
 * literal characters then Enter, never interpreted as a named control chord.
 */
export async function answerAgent(
    sessions: Pick<SessionSource, 'sendKeys'>,
    command: AnswerAgentCommand,
): Promise<AnswerAgentResult> {
    const answer = typeof command.answer === 'string' ? command.answer.trim() : '';
    if (answer === '' || answer.length > 500 || /[\u0000-\u001f\u007f]/.test(answer)) {
        return { ok: false, error: 'Answer with a short line of text.' };
    }
    if (command.eventId !== undefined && (typeof command.eventId !== 'string' || command.eventId.length > 64)) {
        return { ok: false, error: 'That question was already answered or changed.' };
    }
    const keys = Array.from(answer);
    if (keys.length > 1) keys.push('enter');
    await sessions.sendKeys(command.sessionId, keys, command.eventId === undefined ? undefined : { eventId: command.eventId });
    return { ok: true, data: null };
}
