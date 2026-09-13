import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The Dock fixes the owner of a draft before anything asynchronous: a
 * switch to computer B after A acknowledged the spawn — during the visibility
 * wait — must not open A's session on B, store A's first prompt under B, or
 * send A's prompt to B; A's prompt stays recoverable on A.
 */
const wire = vi.hoisted(() => ({
    active: 'host-a',
    sent: [] as Array<{ sessionId: string; machineId: string; text: string }>,
    releaseSpawn: null as null | (() => void),
}));
vi.mock('expo-crypto', () => ({ randomUUID: () => 'first-prompt' }));
vi.mock('@/pairing', () => ({ isMachineOnline: () => true }));
vi.mock('@/utils/readFileBytes', () => ({ readFileBytes: async () => new Uint8Array([1]) }));
vi.mock('../infrastructure/worktree', () => ({ createWorktree: async () => ({ success: false, error: 'unused' }) }));
vi.mock('@/catalog/ops', () => ({
    machineSpawnNewSession: async () => {
        // Spawn acknowledged; the listing wait is where a switch can land.
        await new Promise<void>((resolve) => { wire.releaseSpawn = resolve; });
        return { type: 'success', sessionId: 'agent-a' };
    },
}));
const fakeSync = vi.hoisted(() => ({
    currentMachineId: () => wire.active,
    // The production guard: a submission composed for one computer never
    // goes to the connected other one.
    sendMessage: async (sessionId: string, text: string, options: { machineId: string }) => {
        if (options.machineId !== wire.active) throw Object.assign(new Error('This message was written for a different computer and was not sent.'), { code: 'wrong-machine' });
        wire.sent.push({ sessionId, machineId: options.machineId, text });
    },
    saveAttachments: async () => ({ savedPaths: [] }),
}));
vi.mock('@/catalog/sync', () => ({ sync: fakeSync }));
vi.mock('@/catalog/application/sync', () => ({ sync: fakeSync }));

import { startAgentFromDock } from './StartAgentFromDock';
import { WorktreeSelection } from '../domain/WorktreeSelection';
import { recoverable, useSubmissions } from '@/catalog/application/submissions';

const machineA = { id: 'host-a', active: true, activeAt: Date.now(), metadata: {} } as never;

beforeEach(() => {
    wire.active = 'host-a';
    wire.sent = [];
    wire.releaseSpawn = null;
    useSubmissions.setState({ byTarget: {} });
});

describe('Dock ownership across the spawn wait', () => {
    it('keeps A\'s first prompt on A when the app switches to B after the spawn acknowledgement', async () => {
        const routed: string[] = [];
        const started = startAgentFromDock({
            machine: machineA,
            directory: '/home/u/proj',
            worktree: WorktreeSelection.none(),
            providerKind: 'claude' as never,
            prompt: 'deploy it',
            attachments: [],
            onRouteReady: (sessionId) => routed.push(sessionId),
        });
        await new Promise((resolve) => setTimeout(resolve, 0));
        // Switch to B while A's session is still being listed.
        wire.active = 'host-b';
        wire.releaseSpawn!();
        const result = await started;
        expect(result).toMatchObject({ ok: true, agentRoute: 'agent-a', machineId: 'host-a' });
        // No navigation into B, nothing sent to B, nothing stored under B.
        expect(routed).toEqual([]);
        expect(wire.sent).toEqual([]);
        expect(recoverable({ machineId: 'host-b', sessionId: 'agent-a' })).toEqual([]);
        // A's prompt waits on A, definite (never dispatched), with its text.
        expect(recoverable({ machineId: 'host-a', sessionId: 'agent-a' })).toMatchObject([{ state: 'refused', text: 'deploy it', draft: 'deploy it' }]);

        // Without a switch the same flow opens the route and delivers to A.
        useSubmissions.setState({ byTarget: {} });
        wire.active = 'host-a';
        const plain = startAgentFromDock({ machine: machineA, directory: '/home/u/proj', worktree: WorktreeSelection.none(), providerKind: 'claude' as never, prompt: 'deploy it', attachments: [], onRouteReady: (sessionId) => routed.push(sessionId) });
        await new Promise((resolve) => setTimeout(resolve, 0));
        wire.releaseSpawn!();
        await expect(plain).resolves.toMatchObject({ ok: true, machineId: 'host-a' });
        expect(routed).toEqual(['agent-a']);
        expect(wire.sent).toEqual([{ sessionId: 'agent-a', machineId: 'host-a', text: 'deploy it' }]);

        // A draft for a computer that is not the connected one never starts.
        wire.active = 'host-b';
        await expect(startAgentFromDock({ machine: machineA, directory: '/home/u/proj', worktree: WorktreeSelection.none(), providerKind: 'claude' as never, prompt: 'x', attachments: [] })).resolves.toMatchObject({ ok: false });
    });
});
