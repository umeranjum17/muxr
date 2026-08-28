import * as z from 'zod';
import { isCuid } from '@paralleldrive/cuid2';
import { stripLeadingTaskNotificationWrappers } from '@muxr/wire';
import { MessageMetaSchema, type MessageMeta } from '@/sync/typesMessageMeta';
import { dropSessionEnvelope, usageHeartbeat } from '../domain/sessionEnvelope';

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

function agentMessage(
    envelope: SessionEnvelope,
    localId: string | null,
    meta: MessageMeta | undefined,
    content: NormalizedAgentContent[],
    extra: { claudeUuid?: string; codexItemId?: string } = {},
): NormalizedMessage {
    const parentUUID = envelope.subagent ?? null;
    return {
        id: envelope.id,
        localId,
        createdAt: envelope.time,
        role: 'agent',
        isSidechain: parentUUID !== null,
        content,
        meta,
        usage: envelope.usage,
        ...extra,
    };
}

function fileAttachmentBlocks(envelope: SessionEnvelope): NormalizedAgentContent[] {
    if (envelope.ev.t !== 'file') return [];
    const event = envelope.ev;
    const parentUUID = envelope.subagent ?? null;
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
    return [
        {
            type: 'tool-call',
            id: envelope.id,
            name: 'file',
            input,
            description,
            uuid: envelope.id,
            parentUUID,
        },
        {
            type: 'tool-result',
            tool_use_id: envelope.id,
            content: null,
            is_error: false,
            uuid: `${envelope.id}:result`,
            parentUUID: envelope.id,
        },
    ];
}

function normalizeSessionEnvelope(
    envelope: SessionEnvelope,
    localId: string | null,
    meta: MessageMeta | undefined,
): NormalizedMessage | null {
    if (dropSessionEnvelope(envelope)) return null;

    const messageId = envelope.id;
    const createdAt = envelope.time;
    const parentUUID = envelope.subagent ?? null;
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
            if (!usageHeartbeat(envelope)) {
                content.push({ type: 'text', text: event.text, uuid: messageId, parentUUID });
            }
            return agentMessage(envelope, localId, meta, content);
        }
        case 'text': {
            const visibleText = stripLeadingTaskNotificationWrappers(event.text);
            const wrapperWasStripped = visibleText !== event.text;
            if (wrapperWasStripped && visibleText.trim().length === 0) return null;
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
            const content: NormalizedAgentContent[] = event.thinking
                ? [{ type: 'thinking', thinking: visibleText, uuid: messageId, parentUUID }]
                : [{ type: 'text', text: visibleText, uuid: messageId, parentUUID }];
            return agentMessage(envelope, localId, meta, content, {
                claudeUuid: envelope.claudeUuid,
                codexItemId: envelope.codexItemId,
            });
        }
        case 'tool-call-start':
            return agentMessage(envelope, localId, meta, [{
                type: 'tool-call',
                id: event.call,
                name: event.name || 'unknown',
                input: event.args,
                description: event.description,
                uuid: messageId,
                parentUUID,
            }]);
        case 'tool-call-end':
            return agentMessage(envelope, localId, meta, [{
                type: 'tool-result',
                tool_use_id: event.call,
                content: null,
                is_error: false,
                uuid: messageId,
                parentUUID,
            }]);
        case 'file':
            return agentMessage(envelope, localId, meta, fileAttachmentBlocks(envelope));
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
