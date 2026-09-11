import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Submission A is delayed after its session exists; the user types B in
 * the meantime. Whatever happens to A, B survives, A is recoverable on the
 * session it created, and a second Send cannot start a second agent.
 */
const harness = vi.hoisted(() => ({
    calls: [] as Array<{ prompt: string; onRouteReady?: (id: string) => void }>,
    finish: null as ((result: unknown) => void) | null,
}));

vi.mock('@/catalog/application/persistence', () => ({ loadNewSessionDraft: () => null, saveNewSessionDraft: () => undefined }));
vi.mock('@/connection', () => ({ getCachedConnectionSettings: () => ({ machineId: 'm1' }) }));
vi.mock('@/modal', () => ({ Modal: { alert: vi.fn(), confirm: vi.fn() } }));
vi.mock('@/text', () => ({ t: (key: string) => key }));
vi.mock('./StartAgentFromDock', () => ({
    startAgentFromDock: (command: { prompt: string; onRouteReady?: (id: string) => void }) => {
        harness.calls.push(command);
        return new Promise((resolve) => { harness.finish = resolve; });
    },
}));

import { startSessionFromDraft } from './startSessionFromDraft';
import { useNewSessionDraft } from './useNewSessionDraft';
import { useUndeliveredSubmission } from '@/catalog/application/undeliveredSubmission';

const machines = [{ id: 'm1', metadata: { homeDir: '/home/u' } }] as never;
const navigate = vi.fn();

beforeEach(() => {
    harness.calls = [];
    harness.finish = null;
    navigate.mockClear();
    useNewSessionDraft.setState({ input: '', attachments: [], selectedMachineId: 'm1', selectedPath: '/w', sessionType: 'simple' });
});

describe('draft submission ownership', () => {
    it('releases only the submitted A at route-ready, keeps a newer B, and recovers a failed A on its session', async () => {
        useNewSessionDraft.getState().setInput('A');
        const first = startSessionFromDraft({ machines, navigateToSession: navigate });
        await Promise.resolve();
        expect(harness.calls).toHaveLength(1);
        // A second Send from any surface while A is in flight is the same submission.
        const again = startSessionFromDraft({ machines, navigateToSession: navigate });
        expect(again).toBe(first);
        expect(harness.calls).toHaveLength(1);

        // Session exists: A leaves the Dock, the route opens.
        harness.calls[0]!.onRouteReady!('pp_a');
        expect(useNewSessionDraft.getState().input).toBe('');
        expect(navigate).toHaveBeenCalledWith('pp_a');

        // User types B while A's first message is still being delivered.
        useNewSessionDraft.getState().setInput('B');
        harness.finish!({ ok: true, agentRoute: 'pp_a', promptFailed: 'timed out' });
        await expect(first).resolves.toBe('pp_a');
        expect(useNewSessionDraft.getState().input).toBe('B');
        expect(useUndeliveredSubmission.getState().bySession['pp_a']).toMatchObject({ text: 'A' });
        expect(navigate).toHaveBeenCalledTimes(1);
    });

    it('never releases B when A succeeds late either', async () => {
        useNewSessionDraft.getState().setInput('A');
        const first = startSessionFromDraft({ machines, navigateToSession: navigate });
        await Promise.resolve();
        // B typed before the session even exists: route-ready must not clear it.
        useNewSessionDraft.getState().setInput('B');
        harness.calls[0]!.onRouteReady!('pp_b');
        expect(useNewSessionDraft.getState().input).toBe('B');
        harness.finish!({ ok: true, agentRoute: 'pp_b' });
        await first;
        expect(useNewSessionDraft.getState().input).toBe('B');
        expect(useUndeliveredSubmission.getState().bySession['pp_b']).toBeUndefined();
    });
});
