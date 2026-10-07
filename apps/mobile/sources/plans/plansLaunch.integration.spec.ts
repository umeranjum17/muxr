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

const { planConnection, planAccountForLaunch, planLaunchQuestion, refreshPlans, waitForPlanDiscovery, usePlansStore } = await import('./application/plansStore');
const { choiceLine, providerEntry } = await import('./domain/planAccounts');

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

        // Picked account signs out: back to Auto's pick, not a dead launch, but
        // never in silence. The dock names the pick, and Start asks first.
        usePlansStore.getState().choose('claude', 'pa_work');
        request.mockResolvedValueOnce({ providers: [{ ...claude({ work: { signedIn: false } }), auto: { accountId: 'found-claude', reason: '' } }] });
        await refreshPlans();
        expect(planAccountForLaunch('claude')).toBe('auto');
        const signedOut = providerEntry(usePlansStore.getState().list, 'claude')!;
        expect(choiceLine(signedOut, 'pa_work')).toEqual({ value: 'Work is signed out', detail: 'Sign in, or use Personal' });
        expect(planLaunchQuestion('claude', 'auto')).toMatchObject({ title: 'Work is signed out', instead: { label: 'Use Personal', choice: 'auto' } });
        expect(planLaunchQuestion('claude', 'auto', true)).toBeUndefined();

        // An account with no room left: Start offers the roomier one, or starts anyway.
        const room = (work: number, personal: number, reason = "Right now that's Personal") => ({ providers: [{
            ...claude(),
            accounts: claude().accounts.map((account) => ({ ...account, roomLeftPercent: account.id === 'pa_work' ? work : account.id === 'found-claude' ? personal : undefined })),
            auto: { accountId: 'found-claude', reason },
        }] });
        request.mockResolvedValueOnce(room(0, 40));
        await refreshPlans();
        expect(planAccountForLaunch('claude')).toBe('pa_work');
        expect(planLaunchQuestion('claude', 'pa_work')).toMatchObject({
            title: 'Work is out of room',
            instead: { label: 'Use Personal', choice: 'found-claude' },
            anyway: 'Start anyway',
        });
        expect(planLaunchQuestion('claude', 'found-claude', true)).toBeUndefined();
        // Every account empty: Auto still has a pick, and Start still says so.
        // The title states the fact; the body adds the clock and the cost, never the title again.
        request.mockResolvedValueOnce(room(0, 0, 'All Claude accounts are out of room until 6:09 PM. Personal refills first.'));
        await refreshPlans();
        usePlansStore.getState().choose('claude', 'auto');
        expect(planLaunchQuestion('claude', 'auto')).toEqual({
            title: 'All accounts are out of room',
            message: "Personal refills first at 6:09 PM. An agent started now can't answer until then.",
            anyway: 'Start anyway',
        });
        // No reset clock from the host: still no title restated, still the cost.
        request.mockResolvedValueOnce(room(0, 0, 'All Claude accounts are out of room. Personal refills first.'));
        await refreshPlans();
        expect(planLaunchQuestion('claude', 'auto')?.message).toBe("Personal refills first. An agent started now can't answer until then.");
        request.mockResolvedValueOnce(room(0, 0, ''));
        await refreshPlans();
        expect(planLaunchQuestion('claude', 'auto')?.message).toBe("A Claude account refills first. An agent started now can't answer until then.");

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

describe('starting with no signed-in account', () => {
    it('names the state on the dock and stops Start before a silent launch', async () => {
        connection.machineId = 'computer-d';
        planConnection();
        const allOut = {
            provider: 'claude',
            label: 'Claude',
            accounts: [
                { id: 'found-claude', provider: 'claude', name: 'Personal', foundOnComputer: true, signedIn: false },
                { id: 'pa_work', provider: 'claude', name: 'Work', signedIn: false },
            ],
            auto: { reason: 'No signed-in Claude account.' },
        };
        request.mockResolvedValueOnce({ providers: [allOut] });
        await refreshPlans();
        const entry = providerEntry(usePlansStore.getState().list, 'claude')!;
        // The launch still carries Auto; the question below is what stops it.
        expect(planAccountForLaunch('claude')).toBe('auto');
        // A saved pick is named, with no other account to offer...
        expect(choiceLine(entry, 'pa_work')).toEqual({ value: 'Work is signed out', detail: 'Sign in to use it' });
        // ...and Auto itself says no account is signed in, instead of reading plain Auto.
        expect(choiceLine(entry, 'auto')).toEqual({ value: 'No signed-in account', detail: 'Sign in to start' });
        // Start asks first however the choice reads, with no way to launch on nothing.
        const question = {
            title: 'No signed-in Claude account',
            message: 'Sign in to a Claude account from the Account row first.',
        };
        expect(planLaunchQuestion('claude', 'auto')).toEqual(question);
        expect(planLaunchQuestion('claude', 'auto', true)).toEqual(question);
        connection.machineId = 'computer-a';
        planConnection();
    });
});
