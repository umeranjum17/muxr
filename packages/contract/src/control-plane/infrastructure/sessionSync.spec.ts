import { describe, expect, it } from 'vitest';
import {
    MachineStateUpdateSchema,
    NewMessageUpdateSchema,
    SessionStateUpdateSchema,
    SessionSyncUpdateContainerSchema,
} from './sessionSync.js';

describe('encrypted session-log updates', () => {
    it('parses new-message, session-state, and machine-state updates', () => {
        expect(NewMessageUpdateSchema.safeParse({
            t: 'new-message',
            sid: 'session-1',
            message: {
                id: 'msg-1',
                seq: 10,
                localId: null,
                content: { t: 'encrypted', c: 'ZmFrZS1lbmNyeXB0ZWQ=' },
                createdAt: 123,
                updatedAt: 124,
            },
        }).success).toBe(true);

        expect(SessionStateUpdateSchema.safeParse({
            t: 'update-session',
            id: 'session-1',
            metadata: { version: 2, value: 'abc' },
            agentState: { version: 3, value: null },
        }).success).toBe(true);

        expect(MachineStateUpdateSchema.safeParse({
            t: 'update-machine',
            machineId: 'machine-1',
            metadata: { version: 1, value: 'abc' },
            daemonState: { version: 2, value: 'def' },
            active: true,
            activeAt: 12345,
        }).success).toBe(true);
    });

    it('parses containers for every shared update variant', () => {
        const examples = [
            {
                id: 'upd-1',
                seq: 1,
                body: {
                    t: 'new-message',
                    sid: 'session-1',
                    message: {
                        id: 'msg-1',
                        seq: 1,
                        localId: null,
                        content: { t: 'encrypted', c: 'x' },
                        createdAt: 1,
                        updatedAt: 1,
                    },
                },
                createdAt: 1,
            },
            {
                id: 'upd-2',
                seq: 2,
                body: {
                    t: 'update-session',
                    id: 'session-1',
                    metadata: null,
                    agentState: { version: 1, value: null },
                },
                createdAt: 2,
            },
            {
                id: 'upd-3',
                seq: 3,
                body: {
                    t: 'update-machine',
                    machineId: 'machine-1',
                    metadata: null,
                    daemonState: null,
                },
                createdAt: 3,
            },
        ];

        for (const sample of examples) {
            expect(SessionSyncUpdateContainerSchema.safeParse(sample).success).toBe(true);
        }
    });
});
