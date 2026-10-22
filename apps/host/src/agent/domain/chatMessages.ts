import type { ChatMessage } from '@trymuxr/contract';

export type ChatHarness = 'claude' | 'pi';

/** A message longer than this is cut: the phone shows a conversation, not a file dump. */
export const CHAT_TEXT_MAX = 20_000;
/** The newest this many messages go to the phone. */
export const CHAT_MESSAGES_MAX = 120;

/** Claude Code writes its own bookkeeping into the user turn; none of it is something the person said. */
const NOT_SPOKEN = /^\s*(?:<(?:command-name|command-message|command-args|local-command-stdout|local-command-caveat|system-reminder|bash-input|bash-stdout|bash-stderr)\b|\[Request interrupted by user)/;

interface Block { type?: unknown; text?: unknown }

function textOf(content: unknown): string {
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return '';
    return (content as Block[])
        .filter((block) => block?.type === 'text' && typeof block.text === 'string')
        .map((block) => block.text as string)
        .join('\n\n');
}

function clip(text: string): string {
    return text.length > CHAT_TEXT_MAX ? `${text.slice(0, CHAT_TEXT_MAX)}…` : text;
}

/**
 * One log line to the message it carries, if it carries one. A tool call, a
 * tool result, a thinking block and the harness's own bookkeeping carry none.
 */
function parseLine(harness: ChatHarness, line: string): (ChatMessage & { group: string }) | undefined {
    let entry: Record<string, unknown>;
    try { entry = JSON.parse(line) as Record<string, unknown>; } catch { return undefined; }
    const message = entry.message as { id?: unknown; role?: unknown; content?: unknown; timestamp?: unknown } | undefined;
    if (typeof message !== 'object' || message === null) return undefined;
    if (harness === 'claude' && (entry.isSidechain === true || entry.isMeta === true)) return undefined;
    // A turn Claude Code raises itself (a finished background task) names its origin; a person's own says `human`.
    const origin = entry.origin as { kind?: unknown } | undefined;
    if (harness === 'claude' && typeof origin?.kind === 'string' && origin.kind !== 'human') return undefined;
    if (harness === 'pi' && entry.type !== 'message') return undefined;
    const role = message.role;
    if (role !== 'user' && role !== 'assistant') return undefined;
    const text = textOf(message.content).trim();
    if (text === '' || (role === 'user' && NOT_SPOKEN.test(text))) return undefined;
    const stamp = message.timestamp ?? entry.timestamp;
    const at = typeof stamp === 'number' ? stamp : Date.parse(String(stamp));
    if (!Number.isFinite(at)) return undefined;
    const id = String((harness === 'claude' ? entry.uuid : entry.id) ?? '');
    if (id === '') return undefined;
    // Claude Code writes one line per content block of a reply, all under the reply's id.
    const group = harness === 'claude' && role === 'assistant' && typeof message.id === 'string' ? message.id : id;
    return { id: group, group, role, text, at };
}

/** The conversation in a session log, oldest first, one entry per message. */
export function chatMessagesFrom(harness: ChatHarness, lines: Iterable<string>): ChatMessage[] {
    const out: Array<ChatMessage & { group: string }> = [];
    let last: (ChatMessage & { group: string }) | undefined;
    for (const line of lines) {
        const parsed = parseLine(harness, line);
        if (parsed === undefined) continue;
        if (last !== undefined && last.group === parsed.group && last.role === parsed.role) {
            last.text += `\n\n${parsed.text}`;
            continue;
        }
        last = parsed;
        out.push(parsed);
    }
    return out.map(({ group: _group, ...message }) => ({ ...message, text: clip(message.text) }));
}
