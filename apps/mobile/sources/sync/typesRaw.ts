import * as z from 'zod';
import { isCuid } from '@paralleldrive/cuid2';
import { stripLeadingTaskNotificationWrappers } from '@muxr/wire';
import { MessageMetaSchema, type MessageMeta } from './typesMessageMeta';

const usageDataSchema = z.object({
    input_tokens: z.number(),
    cache_creation_input_tokens: z.number().optional(),
    cache_read_input_tokens: z.number().optional(),
    output_tokens: z.number(),
    context_window: z.number().optional(),
    service_tier: z.string().optional(),
}).passthrough();
export type UsageData = z.infer<typeof usageDataSchema>;

export type AgentEvent = { type: 'ready' };

const sessionEventSchema = z.discriminatedUnion('t', [
    z.object({ t: z.literal('text'), text: z.string(), thinking: z.boolean().optional() }),
    z.object({ t: z.literal('service'), text: z.string() }),
    z.object({
        t: z.literal('tool-call-start'),
        call: z.string(),
        name: z.string(),
        title: z.string(),
        description: z.string(),
        args: z.record(z.string(), z.unknown()),
    }),
    z.object({ t: z.literal('tool-call-end'), call: z.string() }),
    z.object({
        t: z.literal('file'),
        ref: z.string(),
        name: z.string(),
        size: z.number(),
        mimeType: z.string().optional(),
        image: z.object({
            width: z.number(),
            height: z.number(),
            // Native iOS image-picker has no Canvas; FileView skips the placeholder.
            thumbhash: z.string().optional(),
        }).optional(),
    }),
    z.object({ t: z.literal('turn-start') }),
    z.object({ t: z.literal('start'), title: z.string().optional() }),
    z.object({ t: z.literal('turn-end'), status: z.enum(['completed', 'failed', 'cancelled']) }),
    z.object({ t: z.literal('stop') }),
]);

const sessionEnvelopeSchema = z.object({
    id: z.string(),
    time: z.number(),
    role: z.enum(['user', 'agent']),
    turn: z.string().optional(),
    subagent: z.string().refine((value) => isCuid(value), {
        message: 'subagent must be a cuid2 value',
    }).optional(),
    claudeUuid: z.string().min(1).optional(),
    codexItemId: z.string().min(1).optional(),
    usage: usageDataSchema.optional(),
    ev: sessionEventSchema,
}).superRefine((envelope, ctx) => {
    if (envelope.ev.t === 'service' && envelope.role !== 'agent') {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'service events must use role "agent"', path: ['role'] });
    }
    if ((envelope.ev.t === 'start' || envelope.ev.t === 'stop') && envelope.role !== 'agent') {
        ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `${envelope.ev.t} events must use role "agent"`,
            path: ['role'],
        });
    }
});
type SessionEnvelope = z.infer<typeof sessionEnvelopeSchema>;

const rawRecordSchema = z.object({
    role: z.literal('session'),
    content: sessionEnvelopeSchema,
    meta: MessageMetaSchema.optional(),
});
export type RawRecord = z.infer<typeof rawRecordSchema>;
export const RawRecordSchema = rawRecordSchema;

type NormalizedAgentContent =
    | { type: 'text'; text: string; uuid: string; parentUUID: string | null }
    | { type: 'thinking'; thinking: string; uuid: string; parentUUID: string | null }
    | { type: 'tool-call'; id: string; name: string; input: unknown; description: string | null; uuid: string; parentUUID: string | null }
    | {
        type: 'tool-result';
        tool_use_id: string;
        content: unknown;
        is_error: boolean;
        uuid: string;
        parentUUID: string | null;
        permissions?: {
            date: number;
            result: 'approved' | 'denied';
            mode?: string;
            allowedTools?: string[];
            decision?: 'approved' | 'approved_for_session' | 'denied' | 'abort';
        };
    };

export type NormalizedMessage = ({
    role: 'user';
    content: { type: 'text'; text: string };
} | {
    role: 'agent';
    content: NormalizedAgentContent[];
} | {
    role: 'event';
    content: AgentEvent;
}) & {
    id: string;
    localId: string | null;
    createdAt: number;
    isSidechain: boolean;
    meta?: MessageMeta;
    usage?: UsageData;
    claudeUuid?: string;
    codexItemId?: string;
};

const TURN_ENDED: AgentEvent = { type: 'ready' };

function isUsageOnlyService(envelope: SessionEnvelope): boolean {
    return envelope.role === 'agent'
        && envelope.ev.t === 'service'
        && envelope.ev.text.trim().length === 0
        && envelope.usage !== undefined;
}

function normalizeSessionEnvelope(
    envelope: SessionEnvelope,
    localId: string | null,
    meta: MessageMeta | undefined,
): NormalizedMessage | null {
    if (envelope.role === 'agent' && !envelope.turn && !isUsageOnlyService(envelope)) {
        return null;
    }

    const messageId = envelope.id;
    const createdAt = envelope.time;
    const parentUUID = envelope.subagent ?? null;
    const isSidechain = parentUUID !== null;
    const event = envelope.ev;

    switch (event.t) {
        case 'turn-start':
        case 'start':
        case 'stop':
            return null;
        case 'turn-end':
            return {
                id: messageId,
                localId,
                createdAt,
                role: 'event',
                isSidechain: false,
                content: TURN_ENDED,
                meta,
            } satisfies NormalizedMessage;
        case 'service': {
            if (envelope.role !== 'agent') return null;
            const content: NormalizedAgentContent[] = [];
            if (!isUsageOnlyService(envelope)) {
                content.push({ type: 'text', text: event.text, uuid: messageId, parentUUID });
            }
            return {
                id: messageId,
                localId,
                createdAt,
                role: 'agent',
                isSidechain,
                content,
                meta,
                usage: envelope.usage,
            } satisfies NormalizedMessage;
        }
        case 'text': {
            const visibleText = stripLeadingTaskNotificationWrappers(event.text);
            if (visibleText !== event.text && visibleText.trim().length === 0) return null;
            if (envelope.role === 'user') {
                return {
                    id: messageId,
                    localId,
                    createdAt,
                    role: 'user',
                    isSidechain: false,
                    content: { type: 'text', text: visibleText },
                    meta,
                    claudeUuid: envelope.claudeUuid,
                    codexItemId: envelope.codexItemId,
                } satisfies NormalizedMessage;
            }
            const content: NormalizedAgentContent[] = [];
            if (event.thinking) {
                content.push({ type: 'thinking', thinking: visibleText, uuid: messageId, parentUUID });
            } else {
                content.push({ type: 'text', text: visibleText, uuid: messageId, parentUUID });
            }
            return {
                id: messageId,
                localId,
                createdAt,
                role: 'agent',
                isSidechain,
                content,
                meta,
                claudeUuid: envelope.claudeUuid,
                codexItemId: envelope.codexItemId,
                usage: envelope.usage,
            } satisfies NormalizedMessage;
        }
        case 'tool-call-start':
            return {
                id: messageId,
                localId,
                createdAt,
                role: 'agent',
                isSidechain,
                content: [{
                    type: 'tool-call',
                    id: event.call,
                    name: event.name || 'unknown',
                    input: event.args,
                    description: event.description,
                    uuid: messageId,
                    parentUUID,
                }],
                meta,
                usage: envelope.usage,
            } satisfies NormalizedMessage;
        case 'tool-call-end':
            return {
                id: messageId,
                localId,
                createdAt,
                role: 'agent',
                isSidechain,
                content: [{
                    type: 'tool-result',
                    tool_use_id: event.call,
                    content: null,
                    is_error: false,
                    uuid: messageId,
                    parentUUID,
                }],
                meta,
                usage: envelope.usage,
            } satisfies NormalizedMessage;
        case 'file': {
            const input: Record<string, unknown> = {
                ref: event.ref,
                name: event.name,
                size: event.size,
            };
            let description = `Attached file: ${event.name}`;
            if (event.image) {
                input.image = {
                    width: event.image.width,
                    height: event.image.height,
                    thumbhash: event.image.thumbhash,
                };
                description = `Attached image: ${event.name} (${event.image.width}x${event.image.height})`;
            }
            return {
                id: messageId,
                localId,
                createdAt,
                role: 'agent',
                isSidechain,
                content: [
                    {
                        type: 'tool-call',
                        id: messageId,
                        name: 'file',
                        input,
                        description,
                        uuid: messageId,
                        parentUUID,
                    },
                    {
                        type: 'tool-result',
                        tool_use_id: messageId,
                        content: null,
                        is_error: false,
                        uuid: `${messageId}:result`,
                        parentUUID: messageId,
                    },
                ],
                meta,
                usage: envelope.usage,
            } satisfies NormalizedMessage;
        }
    }
}

export function normalizeRawMessage(id: string, localId: string | null, _createdAt: number, raw: RawRecord): NormalizedMessage | null {
    const parsed = rawRecordSchema.safeParse(raw);
    if (!parsed.success) {
        console.warn(`Unrecognized session envelope (id: ${id})`);
        return null;
    }
    return normalizeSessionEnvelope(parsed.data.content, localId, parsed.data.meta);
}
