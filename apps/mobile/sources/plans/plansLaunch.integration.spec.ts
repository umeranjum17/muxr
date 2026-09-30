import { describe, expect, it, vi } from 'vitest';
import type { PlanProviderAccounts } from '@trymuxr/contract';

const request = vi.fn();
const connection = vi.hoisted(() => ({ machineId: 'computer-a', relayUrl: 'ws://lab', token: 'fake' }));
vi.mock('@/connection', () => ({ getCachedConnectionSettings: () => connection }));
const stored = vi.hoisted(() => new Map<string, string | boolean>());

vi.mock('@/catalog/sync', () => ({ sync: { request } }));
vi.mock('@/catalog/store', () => ({ storage: { subscribe: () => () => {} }, useSocketStatus: () => ({ status: 'connected' }) }));
vi.mock('react-native-mmkv', () => ({
    MMKV: class {
        getString(key: string) { return stored.get(key) as string | undefined; }
        getBoolean(key: string) { return stored.get(key) as boolean | undefined; }
        set(key: string, value: string | boolean) { stored.set(key, value); }
    },
}));

const { planConnection, planAccountForLaunch, refreshPlans, waitForPlanDiscovery, usePlansStore } = await import('./application/plansStore');

const claude = (overrides: Partial<Record<'work' | 'side', { signedIn: boolean }>> = {}): PlanProviderAccounts => ({
    provider: 'claude',
    label: 'Claude',
    accounts: [
        { id: 'found-claude', provider: 'claude', name: 'Personal', foundOnComputer: true, signedIn: true, roomLeftPercent: 18 },
        { id: 'pa_work', provider: 'claude', name: 'Work', signedIn: overrides.work?.signedIn ?? true, roomLeftPercent: 72 },
        { id: 'pa_side', provider: 'claude', name: 'Side project', signedIn: overrides.side?.signedIn ?? false },
    ],
    auto: { accountId: 'pa_work', reason: "Right now that's Work: 72% left this week" },
});

describe('which account a launch carries', () => {
    it('follows Auto, the person\'s pick, sign-outs and old hosts, and stays silent with one account', async () => {
        // Codex has one account, so the host omits it: those launches carry nothing new.
        let answerInitial!: (value: unknown) => void;
        request.mockImplementationOnce(() => new Promise((resolve) => { answerInitial = resolve; }));
        const initialRead = refreshPlans();
        let launchReady = false;
        const initialLaunch = waitForPlanDiscovery('claude', planConnection()).then(() => { launchReady = true; });
        await Promise.resolve();
        expect(launchReady).toBe(false);
        answerInitial({ providers: [claude()] });
        await initialRead;
        await initialLaunch;
        const initialCalls = request.mock.calls.length;
        await waitForPlanDiscovery('claude', planConnection());
        expect(request.mock.calls).toHaveLength(initialCalls);
        expect(planAccountForLaunch('claude')).toBe('auto');
        expect(planAccountForLaunch('pi')).toBe('auto');
        usePlansStore.getState().setAutoOn(false);
        expect(planAccountForLaunch('claude')).toBe('pa_work');
        usePlansStore.getState().setAutoOn(true);
        expect(usePlansStore.getState().autoOn).toBe(true);
        expect(planAccountForLaunch('claude')).toBe('auto');
        expect(planAccountForLaunch('codex')).toBeUndefined();
        expect(planAccountForLaunch('gemini')).toBeUndefined();

        // A pick sticks, but a signed-out account is never launched on.
        usePlansStore.getState().choose('claude', 'found-claude');
        expect(planAccountForLaunch('claude')).toBe('found-claude');
        usePlansStore.getState().choose('claude', 'pa_side');
        expect(planAccountForLaunch('claude')).toBe('auto');

        // Picked account signs out: back to Auto's pick, not a dead launch.
        usePlansStore.getState().choose('claude', 'pa_work');
        request.mockResolvedValueOnce({ providers: [{ ...claude({ work: { signedIn: false } }), auto: { accountId: 'found-claude', reason: '' } }] });
        await refreshPlans();
        expect(planAccountForLaunch('claude')).toBe('auto');

        // Auto off with nothing pickable chosen: the computer's own sign-in.
        usePlansStore.getState().setAutoOn(false);
        usePlansStore.getState().choose('claude', 'pa_side');
        request.mockResolvedValueOnce({ providers: [claude()] });
        await refreshPlans();
        expect(planAccountForLaunch('claude')).toBe('found-claude');

        usePlansStore.getState().setAutoOn(true);
        const original = planConnection();
        let answerOld!: (value: unknown) => void;
        request.mockImplementationOnce(() => new Promise((resolve) => { answerOld = resolve; }));
        const oldRead = refreshPlans();
        connection.machineId = 'computer-b';
        expect(planAccountForLaunch('claude')).toBeUndefined();
        request.mockResolvedValueOnce({ providers: [claude()] });
        await refreshPlans();
        const { renameAccount, acknowledgeAutoTerms, moveAgent } = await import('./application/plansApi');
        const count = request.mock.calls.length;
        await expect(renameAccount('found-claude', 'Wrong computer', original)).rejects.toThrow('computer changed');
        expect(request.mock.calls).toHaveLength(count);
        answerOld({ providers: [] });
        await oldRead;
        expect(planAccountForLaunch('claude')).toBe('auto');
        let acknowledgeOld!: () => void;
        request.mockImplementationOnce(() => new Promise<void>((resolve) => { acknowledgeOld = resolve; }));
        const acknowledgment = acknowledgeAutoTerms();
        connection.machineId = 'computer-a';
        planConnection();
        acknowledgeOld();
        await expect(acknowledgment).rejects.toThrow('computer changed');
        const failure = Object.assign(new Error('Original conversation still running'), { code: 'plan-move-start-failed' });
        request.mockRejectedValueOnce(failure);
        await expect(moveAgent('original', 'pa_work')).rejects.toMatchObject({ code: 'plan-move-start-failed' });

        // A host without plans.list answers an error: every launch is today's.
        connection.machineId = 'computer-c';
        planConnection();
        usePlansStore.getState().choose('claude', 'pa_work');
        request.mockRejectedValueOnce(new Error('link disconnected'));
        await expect(waitForPlanDiscovery('claude', planConnection())).rejects.toThrow('Could not check accounts');

        request.mockRejectedValueOnce(Object.assign(new Error('host-contract-mismatch'), { code: 'host-contract-mismatch' }));
        await refreshPlans();
        expect(planAccountForLaunch('claude')).toBeUndefined();
    });
});
