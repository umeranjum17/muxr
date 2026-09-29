import { describe, expect, it, vi } from 'vitest';
import type { PlanProviderAccounts } from '@trymuxr/contract';

const request = vi.fn();
const stored = vi.hoisted(() => new Map<string, string | boolean>());

vi.mock('@/catalog/sync', () => ({ sync: { request } }));
vi.mock('@/catalog/store', () => ({ useSocketStatus: () => ({ status: 'connected' }) }));
vi.mock('react-native-mmkv', () => ({
    MMKV: class {
        getString(key: string) { return stored.get(key) as string | undefined; }
        getBoolean(key: string) { return stored.get(key) as boolean | undefined; }
        set(key: string, value: string | boolean) { stored.set(key, value); }
    },
}));

const { planAccountForLaunch, refreshPlans, usePlansStore } = await import('./application/plansStore');

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
        request.mockResolvedValueOnce({ providers: [claude()] });
        await refreshPlans();
        expect(planAccountForLaunch('claude')).toBe('pa_work');
        expect(planAccountForLaunch('pi')).toBe('pa_work');
        expect(planAccountForLaunch('codex')).toBeUndefined();
        expect(planAccountForLaunch('gemini')).toBeUndefined();

        // A pick sticks, but a signed-out account is never launched on.
        usePlansStore.getState().choose('claude', 'found-claude');
        expect(planAccountForLaunch('claude')).toBe('found-claude');
        usePlansStore.getState().choose('claude', 'pa_side');
        expect(planAccountForLaunch('claude')).toBe('pa_work');

        // Picked account signs out: back to Auto's pick, not a dead launch.
        usePlansStore.getState().choose('claude', 'pa_work');
        request.mockResolvedValueOnce({ providers: [{ ...claude({ work: { signedIn: false } }), auto: { accountId: 'found-claude', reason: '' } }] });
        await refreshPlans();
        expect(planAccountForLaunch('claude')).toBe('found-claude');

        // Auto off with nothing pickable chosen: the computer's own sign-in.
        usePlansStore.getState().setAutoOn(false);
        usePlansStore.getState().choose('claude', 'pa_side');
        request.mockResolvedValueOnce({ providers: [claude()] });
        await refreshPlans();
        expect(planAccountForLaunch('claude')).toBe('found-claude');

        // A host without plans.list answers an error: every launch is today's.
        request.mockRejectedValueOnce(new Error('host-contract-mismatch'));
        await refreshPlans();
        expect(planAccountForLaunch('claude')).toBeUndefined();
    });
});
