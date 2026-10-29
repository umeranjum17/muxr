import { getCachedConnectionSettings } from '@/connection';
import { startRealtimeWithPermission } from './realtimeActions';
import { realtimeSessionSnapshot, speakReport, stopRealtimeSession } from './realtimeSessionState';

/** A spoken reply is cut here: the voice reads an answer, not a file. */
const SPOKEN_MAX = 1_500;

/** What a person would hear: the words of a reply, with its Markdown and code left unread. */
export function spokenText(markdown: string): string {
    return markdown
        .replace(/```[\s\S]*?```/g, ' ')
        .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
        .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
        .replace(/`([^`]*)`/g, '$1')
        .replace(/^\s{0,3}(?:#{1,6}|[-*+>]|\d+\.)\s+/gm, '')
        .replace(/[*_~]{1,3}/g, '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, SPOKEN_MAX);
}

/**
 * Reads an agent's reply aloud through the realtime voice session, the same
 * path a stop report is spoken on. A session that was not live is woken for
 * the reply and put away again after it; a live one is left running.
 */
export async function speakReply(input: { sessionId: string; markdown: string }): Promise<void> {
    const text = spokenText(input.markdown);
    if (text === '') return;
    const wasLive = realtimeSessionSnapshot().state !== 'disconnected';
    if (!wasLive && !(await startRealtimeWithPermission({ machineId: getCachedConnectionSettings().machineId, sessionId: input.sessionId }))) return;
    try {
        await speakReport(text);
    } finally {
        if (!wasLive) stopRealtimeSession();
    }
}
