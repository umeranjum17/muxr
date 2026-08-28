import type { Message } from '@/sync/typesMessage';

export function buildMessagesMap(messages: readonly Message[]): Record<string, Message> {
    const map: Record<string, Message> = {};
    for (const message of messages) map[message.id] = message;
    return map;
}
