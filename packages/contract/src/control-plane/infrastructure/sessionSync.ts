import { z } from 'zod';

/**
 * Encrypted session-log updates the phone decrypts after routing.
 * Distinct from SessionEvent, which is the host's live push vocabulary.
 */

export const EncryptedSessionMessageSchema = z.object({
    id: z.string(),
    seq: z.number(),
    localId: z.string().nullish(),
    content: z.object({
        c: z.string(),
        t: z.literal('encrypted'),
    }),
    createdAt: z.number(),
    updatedAt: z.number(),
});
export type EncryptedSessionMessage = z.infer<typeof EncryptedSessionMessageSchema>;

export const VersionedEncryptedValueSchema = z.object({
    version: z.number(),
    value: z.string(),
});
export type VersionedEncryptedValue = z.infer<typeof VersionedEncryptedValueSchema>;

export const VersionedNullableEncryptedValueSchema = z.object({
    version: z.number(),
    value: z.string().nullable(),
});
export type VersionedNullableEncryptedValue = z.infer<typeof VersionedNullableEncryptedValueSchema>;

export const NewMessageUpdateSchema = z.object({
    t: z.literal('new-message'),
    sid: z.string(),
    message: EncryptedSessionMessageSchema,
});
export type NewMessageUpdate = z.infer<typeof NewMessageUpdateSchema>;

export const SessionStateUpdateSchema = z.object({
    t: z.literal('update-session'),
    id: z.string(),
    metadata: VersionedEncryptedValueSchema.nullish(),
    agentState: VersionedNullableEncryptedValueSchema.nullish(),
});
export type SessionStateUpdate = z.infer<typeof SessionStateUpdateSchema>;

export const MachineStateUpdateSchema = z.object({
    t: z.literal('update-machine'),
    machineId: z.string(),
    metadata: VersionedEncryptedValueSchema.nullish(),
    daemonState: VersionedEncryptedValueSchema.nullish(),
    active: z.boolean().optional(),
    activeAt: z.number().optional(),
});
export type MachineStateUpdate = z.infer<typeof MachineStateUpdateSchema>;

export const SessionSyncUpdateSchema = z.discriminatedUnion('t', [
    NewMessageUpdateSchema,
    SessionStateUpdateSchema,
    MachineStateUpdateSchema,
]);
export type SessionSyncUpdate = z.infer<typeof SessionSyncUpdateSchema>;

export const SessionSyncUpdateContainerSchema = z.object({
    id: z.string(),
    seq: z.number(),
    body: SessionSyncUpdateSchema,
    createdAt: z.number(),
});
export type SessionSyncUpdateContainer = z.infer<typeof SessionSyncUpdateContainerSchema>;
